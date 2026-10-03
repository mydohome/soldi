#!/usr/bin/env bash
# cron.sh — pianificazione degli strumenti di gestione.
#   cron.sh print      stampa le righe consigliate
#   cron.sh install    le aggiunge al crontab dell'utente (idempotente, tra marcatori)
#   cron.sh remove     le toglie
# Orari predefiniti: watch ogni 5 minuti · backup ogni giorno alle 02:30 · controllo dei backup alle 08:00 ·
# prova di ripristino il primo domenica del mese alle 05:00 (con --from-offsite se restic è
# configurato in ops.env: dopo averlo configurato rilancia `soldi cron install`). Gli orari si
# scelgono con `soldi backup-plan` (rileva gli altri job della macchina) e vivono in ops.env.
# Ogni riga passa da cronrun.sh: un solo esemplare alla volta (flock) e log a rotazione in
# ops-state/<job>.log. Il crontab è quello dell'utente che lancia il comando (variabile CRONTAB
# per cambiare il comando, usata dai test).
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

ACTION="${1:-print}"; [ $# -eq 0 ] || shift
SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
CRONTAB="${CRONTAB:-crontab}"
BEGIN='# BEGIN soldi'; END='# END soldi'

case "$COMPOSE_DIR$OPS_DIR" in *\'*) die "Il percorso contiene un apice: non lo posso scrivere in modo sicuro nel crontab." ;; esac

# Orari: i valori predefiniti si cambiano con `soldi backup-plan` (che li scrive in ops.env) o a
# mano: CRON_BACKUP_AT=HH:MM, CRON_BACKUP_DAYS=* oppure elenco di giorni cron (es. 1,3,5),
# CRON_CHECK_AT=HH:MM, CRON_RESTORETEST_AT=HH:MM, CRON_WATCH_EVERY=minuti (1-59).
hhmm() { # NOME_VARIABILE default → "minuto ora"
  local v; v="$(opsval "$1")"; v="${v:-$2}"
  case "$v" in
    [0-9]:[0-5][0-9]|[01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) printf '%d %d' "$((10#${v#*:}))" "$((10#${v%%:*}))" ;;
    *) die "$1=\"$v\" non valido: usa HH:MM (es. 03:15)." ;;
  esac
}
block() {
  local from="" bk ck rt days every
  if restic_configured; then from=" --from-offsite"; fi
  bk="$(hhmm CRON_BACKUP_AT 02:30)"; ck="$(hhmm CRON_CHECK_AT 08:00)"; rt="$(hhmm CRON_RESTORETEST_AT 05:00)"
  days="$(opsval CRON_BACKUP_DAYS)"; days="${days:-*}"
  case "$days" in '*') ;; *[!0-6,]*|'') die "CRON_BACKUP_DAYS=\"$days\" non valido: usa * oppure giorni cron 0-6 separati da virgola (0 = domenica)." ;; esac
  every="$(opsval CRON_WATCH_EVERY)"; every="${every:-5}"
  case "$every" in ''|*[!0-9]*) die "CRON_WATCH_EVERY non valido (minuti, 1-59)." ;; esac
  { [ "$every" -ge 1 ] && [ "$every" -le 59 ]; } || die "CRON_WATCH_EVERY non valido (minuti, 1-59)."
  local pre="SOLDI_HOME='$COMPOSE_DIR' PATH=/usr/local/bin:/usr/bin:/bin"
  local run="$OPS_DIR/cronrun.sh"
  echo "$BEGIN (gestito da: soldi cron install — non modificare a mano questo blocco; orari: soldi backup-plan)"
  echo "*/$every * * * * $pre $run watch -- $OPS_DIR/watch.sh"
  echo "$bk * * $days $pre $run backup -- $OPS_DIR/backup.sh"
  echo "$ck * * * $pre $run backup-check -- $OPS_DIR/backup-check.sh"
  # cron unisce giorno del mese e giorno della settimana con un OR: il controllo sul giorno
  # (1-7) si fa nel comando, così parte solo la prima domenica del mese
  echo "$rt * * 0 [ \"\$(date +\\%d)\" -le 7 ] && $pre $run restore-test -- $OPS_DIR/restore-test.sh$from"
  echo "$END"
}
current() { "$CRONTAB" -l 2>/dev/null || true; }
without_block() { current | awk -v b="$BEGIN" -v e="$END" 'index($0, b) == 1 { skip = 1; next } skip && $0 == e { skip = 0; next } !skip { print }'; }

case "$ACTION" in
  print) block ;;
  install)
    command -v "$CRONTAB" >/dev/null 2>&1 || die "Comando crontab non trovato."
    # il nuovo contenuto si compone PRIMA di scriverlo (crontab - non deve leggere sé stesso)
    new="$({ without_block; block; })"
    printf '%s\n' "$new" | "$CRONTAB" -
    ok "Pianificazione installata nel crontab di $(id -un). Verifica con: crontab -l"
    ;;
  remove)
    command -v "$CRONTAB" >/dev/null 2>&1 || die "Comando crontab non trovato."
    new="$(without_block)"
    printf '%s\n' "$new" | "$CRONTAB" -
    ok "Blocco soldi rimosso dal crontab."
    ;;
  *) die "Uso: soldi cron print|install|remove" ;;
esac
