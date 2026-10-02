#!/usr/bin/env bash
# backup.sh — backup quotidiano completo di Soldi.
#   1. backup applicativo (npm run backup nel container web → backups/soldi-backup-*)
#   2. dump PostgreSQL compresso e verificato (backups/dumps/soldi-AAAAMMGG-hhmmss.sql.gz)
#   3. retention dei dump (DUMP_KEEP, default 14)
#   4. copia fuori macchina cifrata con restic, se RESTIC_REPOSITORY è in ops.env
#
# Perché giornaliero: il backup applicativo da solo è settimanale (fino a 7 giorni di
# dati persi); con il dump quotidiano la perdita massima diventa 24 ore.
#
# Uso: backup.sh [--home <cartella>]      Uscita: 0 ok, 1 errore, 2 avviso.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose
job_begin backup
lock_acquire backup
check_ops_env_perms

KEEP="$(opsval DUMP_KEEP)"; KEEP="${KEEP:-14}"
case "$KEEP" in ''|*[!0-9]*) die "DUMP_KEEP non valido: $KEEP" ;; esac

service_up() { $DC ps --status running --services 2>/dev/null | grep -x "$1" >/dev/null; }
service_up db || die "Il container db non è in esecuzione: avvia lo stack (docker compose up -d)."

problems=""; fatal=0
add_problem() { problems="${problems:+$problems; }$1"; }

# 1. backup applicativo
app_status=ok
if service_up web; then
  log "Backup applicativo (npm run backup)…"
  if $DC exec -T web npm run backup >&2; then ok "Backup applicativo creato."; else app_status=fail; fatal=1; add_problem "backup applicativo FALLITO"; fi
else
  app_status=skipped
  warn "Il container web non è in esecuzione: salto il backup applicativo."
  add_problem "backup applicativo saltato (web non in esecuzione)"
fi

# 2. dump PostgreSQL
dump="$DUMPS_DIR/soldi-$(date +%Y%m%d-%H%M%S).sql.gz"
dump_status=ok
log "Dump PostgreSQL → $(basename "$dump")"
if dump_db "$dump"; then
  ok "Dump verificato ($(wc -c < "$dump" | tr -d ' ') byte)."
  # 3. retention
  prune_keep "$DUMPS_DIR" 'soldi-*.sql.gz' "$KEEP"
else
  dump_status=fail; fatal=1; add_problem "dump PostgreSQL FALLITO (file scartato)"
  err "Dump non riuscito o non valido: scartato."
fi

# 4. copia fuori macchina
offsite_status=skipped
if [ -n "$(opsval RESTIC_REPOSITORY)" ]; then
  log "Copia fuori macchina (restic)…"
  rc=0; "$OPS_DIR/offsite.sh" --home "$COMPOSE_DIR" || rc=$?
  case "$rc" in
    0) offsite_status=ok ;;
    2) offsite_status=warn; add_problem "copia fuori macchina: avviso (vedi ops-state/offsite.json)" ;;
    *) offsite_status=fail; add_problem "copia fuori macchina FALLITA (vedi ops-state/offsite.json)" ;;
  esac
fi

details="$(printf '{"appBackup":%s,"dump":%s,"offsite":"%s","dumpStatus":"%s","appBackupStatus":"%s"}' \
  "$(json_str "$(basename "$(latest_app_backup)")")" "$(json_str "$(basename "$dump")")" "$offsite_status" "$dump_status" "$app_status")"

if [ "$fatal" = 1 ]; then job_finish fail "Backup NON riuscito: $problems" "$details"; fi
if [ -n "$problems" ]; then job_finish warn "Backup locale ok, ma: $problems" "$details"; fi
job_finish ok "Backup completato: $(basename "$dump"), $(basename "$(latest_app_backup)")" "$details"
