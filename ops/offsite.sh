#!/usr/bin/env bash
# offsite.sh — copia fuori macchina CIFRATA con restic (unica destinazione supportata).
#
# Salva la cartella backups/ (CSV applicativi e dump) e il file .env — che contiene
# JWT_SECRET, SECRETS_KEY e PGPASSWORD: senza SECRETS_KEY le impostazioni Telegram
# cifrate non si leggono più dopo un ripristino su un'altra macchina. Nel layout
# "deploy" salva anche il docker-compose.yml di produzione (non è nel repository).
#
# Configurazione in ops.env: RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE (file 600 fuori
# dal repository) e le credenziali del backend (AWS_*, B2_*, …).
#
# Uso: offsite.sh [--init] [--home <cartella>]
#   --init   crea il repository restic (mai in automatico)
# Uscita: 0 ok, 1 errore, 2 avviso (es. copia fuori macchina NON configurata).
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

DO_INIT=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --init) DO_INIT=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
RESTIC="${RESTIC:-restic}"

repo="$(opsval RESTIC_REPOSITORY)"
pwfile="$(opsval RESTIC_PASSWORD_FILE)"
missing=""
[ -n "$repo" ] || missing="RESTIC_REPOSITORY"
[ -n "$pwfile" ] || missing="${missing:+$missing, }RESTIC_PASSWORD_FILE"
if [ -n "$missing" ]; then
  state_write offsite warn "copia fuori macchina NON configurata (manca $missing in ops.env)"
  warn "Copia fuori macchina NON configurata (manca $missing in ops.env). Vedi docs/OPERATIONS.md."
  exit 2
fi
if ! command -v "$RESTIC" >/dev/null 2>&1; then
  state_write offsite warn "copia fuori macchina NON configurata: restic non è installato"
  warn "Copia fuori macchina NON configurata: restic non è installato (apt install restic)."
  exit 2
fi

job_begin offsite
lock_acquire offsite
check_ops_env_perms

[ -f "$pwfile" ] || die "RESTIC_PASSWORD_FILE non esiste: $pwfile"
case "$pwfile" in "$APP_DIR"/*) die "RESTIC_PASSWORD_FILE non deve stare dentro il repository ($APP_DIR): spostalo e usa chmod 600." ;; esac
case "$(file_mode "$pwfile")" in 600|400) ;; *) die "RESTIC_PASSWORD_FILE ha permessi troppo aperti: chmod 600 \"$pwfile\"" ;; esac

export_ops_prefix RESTIC_ AWS_ B2_ AZURE_ GOOGLE_ OS_ ST_
export RESTIC_REPOSITORY="$repo" RESTIC_PASSWORD_FILE="$pwfile"
# Del repository si mostra solo il tipo (l'URL può contenere credenziali).
repo_type="${repo%%:*}"; case "$repo" in *:*) ;; *) repo_type=local ;; esac

if [ "$DO_INIT" = 1 ]; then
  log "Creo il repository restic ($repo_type)…"
  "$RESTIC" init >&2 || die "restic init non riuscito."
  job_finish ok "Repository restic creato ($repo_type). Conserva la password di restic anche FUORI da questa macchina."
fi

"$RESTIC" cat config >/dev/null 2>&1 || die "Repository restic non raggiungibile o non inizializzato ($repo_type). Per crearlo: soldi offsite --init"

paths=("$BACKUPS_DIR" "$COMPOSE_DIR/.env")
if [ "$LAYOUT" = deploy ]; then paths+=("$COMPOSE_DIR/docker-compose.yml"); fi

weekly_due() { # file-stamp
  local last=0
  [ -f "$1" ] && last="$(cat "$1" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $(( $(now_epoch) - last )) -ge $((7 * 24 * 3600 - 3600)) ]
}

status=ok; notes=""
log "restic backup ($repo_type)…"
rc=0; "$RESTIC" backup --tag soldi "${paths[@]}" >&2 || rc=$?
case "$rc" in
  0) ;;
  3) status=warn; notes="snapshot creato ma alcuni file non erano leggibili" ;;
  *) die "restic backup non riuscito (codice $rc)." ;;
esac

prune=""; pruned=false
if weekly_due "$STATE_DIR/offsite-prune.stamp"; then prune="--prune"; pruned=true; fi
log "restic forget (daily 14, weekly 8, monthly 12) ${prune}"
# $prune è vuoto oppure --prune: senza virgolette di proposito.
# shellcheck disable=SC2086
"$RESTIC" forget --tag soldi --keep-daily 14 --keep-weekly 8 --keep-monthly 12 $prune >&2 || die "restic forget non riuscito."
if [ "$pruned" = true ]; then now_epoch > "$STATE_DIR/offsite-prune.stamp"; fi

checked=false
if weekly_due "$STATE_DIR/offsite-check.stamp"; then
  log "restic check (5% dei dati)…"
  "$RESTIC" check --read-data-subset=5% >&2 || die "restic check ha trovato problemi nel repository: NON fidarti di questa copia finché non è risolto."
  now_epoch > "$STATE_DIR/offsite-check.stamp"; checked=true
fi

details="$(printf '{"repositoryType":%s,"pruned":%s,"checked":%s}' "$(json_str "$repo_type")" "$pruned" "$checked")"
if [ "$status" = warn ]; then job_finish warn "Copia fuori macchina: $notes" "$details"; fi
job_finish ok "Copia fuori macchina completata ($repo_type)." "$details"
