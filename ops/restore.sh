#!/usr/bin/env bash
# restore.sh — ripristino guidato di un backup applicativo sul sistema esistente
# (dati corrotti, errore umano). Per ricostruire una macchina nuova usa dr.sh.
#
#   1. sceglie il backup (elenco, --latest o --source), ne mostra data e righe per tabella
#   2. chiede di digitare RIPRISTINA (con --yes solo insieme a --source)
#   3. dump di sicurezza dello stato ATTUALE (backups/dumps/pre-restore-*.sql.gz)
#   4. ferma web, restore.js in un container usa-e-getta (stessa immagine e reti, --no-deps),
#      riavvia web, attende lo stato sano, lancia la diagnostica
#   5. se un passaggio fallisce stampa il comando esatto per tornare al dump di sicurezza
#
# Uso: restore.sh [--source <cartella|nome>] [--latest] [--yes] [--home <cartella>]
# Il backup deve stare dentro backups/ (nel container è montata come /app/backups).
# Uscita: 0 ok, 1 errore.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

SOURCE=""; LATEST=0; YES=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --yes) YES=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
[ "$YES" -eq 0 ] || [ -n "$SOURCE" ] || { err "--yes si usa solo insieme a --source <backup>: un ripristino distruttivo non si sceglie alla cieca."; exit 1; }
detect_layout
choose_compose
JOB_NOTIFY_OK=1
job_begin restore
lock_acquire update   # stesso lock di aggiornamento e ripristino di emergenza: mai insieme

# --- 1. scelta del backup ---------------------------------------------------------------
list_backups() { # più recenti per primi
  local d n ts
  for d in "$BACKUPS_DIR"/soldi-backup-*; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"; ts="${n#soldi-backup-}"
    [ "${#ts}" -ne 19 ] || ts="$ts-000"
    printf '%s %s\n' "$ts" "$n"
  done | sort -r | cut -d' ' -f2
}
BACKUP_NAME=""
if [ -n "$SOURCE" ]; then
  case "$SOURCE" in */*) cand="$SOURCE" ;; *) cand="$BACKUPS_DIR/$SOURCE" ;; esac
  [ -d "$cand" ] || die "Backup non trovato: $SOURCE"
  cand="$(cd "$cand" && pwd)"
  [ "$(dirname "$cand")" = "$BACKUPS_DIR" ] || die "Il backup deve stare dentro $BACKUPS_DIR (nel container è /app/backups): copialo lì."
  BACKUP_NAME="$(basename "$cand")"
elif [ "$LATEST" -eq 1 ]; then
  BACKUP_NAME="$(list_backups | head -n 1)"
  [ -n "$BACKUP_NAME" ] || die "Nessun backup applicativo in $BACKUPS_DIR."
else
  [ -t 0 ] || die "Senza terminale indica il backup: --source <nome> oppure --latest."
  names="$(list_backups | head -n 10)"
  [ -n "$names" ] || die "Nessun backup applicativo in $BACKUPS_DIR."
  i=0
  while IFS= read -r n; do
    i=$((i + 1))
    printf '  %2d) %s  (%s)\n' "$i" "$n" "$(manifest_value "$BACKUPS_DIR/$n/manifest.json" createdAt 2>/dev/null)" >&2
  done <<< "$names"
  printf 'Quale backup? [1 = il più recente] ' >&2
  read -r pick; pick="${pick:-1}"
  case "$pick" in ''|*[!0-9]*) die "Scelta non valida." ;; esac
  BACKUP_NAME="$(printf '%s\n' "$names" | sed -n "${pick}p")"
  [ -n "$BACKUP_NAME" ] || die "Scelta non valida."
fi
case "$BACKUP_NAME" in soldi-user-backup-*) die "$BACKUP_NAME è un backup personale: per ripristinarlo usa  npm run user:restore." ;; esac
MANIFEST="$BACKUPS_DIR/$BACKUP_NAME/manifest.json"
[ -f "$MANIFEST" ] || die "$BACKUP_NAME: manifest.json mancante: backup non valido."
[ "$(manifest_value "$MANIFEST" kind)" != user ] || die "$BACKUP_NAME è un backup personale: per ripristinarlo usa  npm run user:restore."

# --- 2. riepilogo e conferma ---------------------------------------------------------------
{
  printf '\nBackup scelto: %s\n  creato il: %s (%s)\n  righe per tabella:\n' "$BACKUP_NAME" "$(manifest_value "$MANIFEST" createdAt)" "$(manifest_value "$MANIFEST" label)"
  manifest_tables "$MANIFEST" | while read -r t n; do printf '    %-18s %s\n' "$t" "$n"; done
  printf '\nIl ripristino SOSTITUISCE TUTTI i dati attuali (tutti gli utenti) con quelli del backup.\n'
} >&2
if [ "$YES" -ne 1 ]; then
  confirm_typed RIPRISTINA "" || die "Annullato: nessuna modifica."
fi

# --- 3. dump di sicurezza dello stato attuale -------------------------------------------------
service_up() { $DC ps --status running --services 2>/dev/null | grep -x "$1" >/dev/null; }
service_up db || die "Il container db non è in esecuzione: avvia almeno il database (docker compose up -d db)."
SAFETY="$DUMPS_DIR/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
log "Dump di sicurezza dello stato attuale → $(basename "$SAFETY")"
dump_db "$SAFETY" || die "Dump di sicurezza non riuscito: NON modifico nulla."
prune_keep "$DUMPS_DIR" 'pre-restore-*.sql.gz' 5
ok "Dump di sicurezza creato."

rollback_hint() {
  printf '\nPer tornare allo stato PRECEDENTE al ripristino:\n  %s stop web\n  gzip -dc "%s" | %s exec -T db psql -v ON_ERROR_STOP=1 -U %s -d %s\n  %s up -d web\n' \
    "$DC" "$SAFETY" "$DC" "$(PGUSER_ENV)" "$(PGDATABASE_ENV)" "$DC" >&2
}
fail_restore() { # messaggio
  rollback_hint
  $DC up -d web >&2 || true   # restore.js lavora in una transazione: se è fallito i dati sono intatti
  JOB_ERR="$1 Dump di sicurezza: $(basename "$SAFETY")"
  err "$1"
  exit 1
}

# --- 4. ripristino ---------------------------------------------------------------------------
log "Fermo web…"
$DC stop web >&2 || true
log "Ripristino $BACKUP_NAME in un container usa-e-getta…"
restore_in_container "$BACKUP_NAME" || fail_restore "Ripristino NON riuscito."
log "Riavvio web…"
$DC up -d web >&2 || fail_restore "Impossibile riavviare web dopo il ripristino."
wait_healthy || fail_restore "web non è tornato in salute dopo il ripristino."

diag_note="diagnostica non disponibile nell'immagine (richiede la ricostruzione)"
rc=0; run_diag || rc=$?
case "$rc" in
  0) diag_note="diagnostica ok" ;;
  3) warn "$diag_note" ;;
  2) diag_note="diagnostica con avvisi"; warn "$diag_note" ;;
  *) fail_restore "La diagnostica ha trovato ERRORI nei dati ripristinati." ;;
esac

details="$(printf '{"backup":%s,"safetyDump":%s}' "$(json_str "$BACKUP_NAME")" "$(json_str "$(basename "$SAFETY")")")"
job_finish ok "Ripristino completato da $BACKUP_NAME ($diag_note). Dump di sicurezza: $(basename "$SAFETY")" "$details"
