#!/usr/bin/env bash
# backup-check.sh — verifica che i backup esistano, siano recenti e leggibili.
#
# Controlli: ultimo backup applicativo (età, manifest, utenti > 0), ultimo dump
# (età + integrità), ultimo snapshot restic, spazio libero, ultima prova di ripristino.
# Uscita: 0 ok, 2 avviso, 1 errore. Notifica solo i cambi di stato (o al più una
# volta ogni 24 ore per lo stesso problema) e il rientro.
#
# Soglie (ops.env o ambiente): BACKUP_MAX_AGE_HOURS (192), DUMP_MAX_AGE_HOURS (30),
# OFFSITE_MAX_AGE_HOURS (30), DISK_MIN_FREE_PCT (15), RESTORE_TEST_MAX_AGE_DAYS (40).
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
    -h|--help) sed -n '2,11p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
RESTIC="${RESTIC:-restic}"
JOB_NO_NOTIFY=1   # le notifiche le gestisce questo script, controllo per controllo
job_begin backup-check

num() { local v; v="$(opsval "$1")"; case "$v" in ''|*[!0-9]*) echo "$2" ;; *) echo "$v" ;; esac; }
MAX_APP_H="$(num BACKUP_MAX_AGE_HOURS 192)"
MAX_DUMP_H="$(num DUMP_MAX_AGE_HOURS 30)"
MAX_OFFSITE_H="$(num OFFSITE_MAX_AGE_HOURS 30)"
MIN_FREE="$(num DISK_MIN_FREE_PCT 15)"
MAX_RT_DAYS="$(num RESTORE_TEST_MAX_AGE_DAYS 40)"

RESULTS=""   # righe "nome|livello|messaggio"
add() { RESULTS="${RESULTS}$1|$2|$3"$'\n'; }
hours_since() { echo $(( ( $(now_epoch) - $1 ) / 3600 )); }

# 1. backup applicativo
check_app() {
  local d m rows h
  d="$(latest_app_backup)"
  [ -n "$d" ] || { add app ERRORE "nessun backup applicativo in $BACKUPS_DIR"; return; }
  m="$d/manifest.json"
  [ -f "$m" ] || { add app ERRORE "$(basename "$d"): manifest.json mancante"; return; }
  rows="$(manifest_rows "$m" users)"
  if [ "$(manifest_value "$m" app)" != soldi ] || [ -z "$rows" ]; then add app ERRORE "$(basename "$d"): manifest.json non valido"; return; fi
  h="$(hours_since "$(file_mtime "$m")")"
  if [ "$h" -gt "$MAX_APP_H" ]; then add app ERRORE "ultimo backup applicativo vecchio di ${h} ore (soglia ${MAX_APP_H})"; return; fi
  if [ "$rows" -le 0 ]; then add app ERRORE "$(basename "$d"): nessun utente nel backup"; return; fi
  add app OK "ultimo backup applicativo $(basename "$d") (${h} ore fa, ${rows} utenti)"
}
# 2. dump
check_dump() {
  local f h
  f="$(latest_file "$DUMPS_DIR" 'soldi-*.sql.gz')"
  [ -n "$f" ] || { add dump ERRORE "nessun dump in $DUMPS_DIR"; return; }
  h="$(hours_since "$(file_mtime "$f")")"
  if ! verify_dump "$f"; then add dump ERRORE "$(basename "$f"): dump corrotto o incompleto"; return; fi
  if [ "$h" -gt "$MAX_DUMP_H" ]; then add dump ERRORE "ultimo dump vecchio di ${h} ore (soglia ${MAX_DUMP_H})"; return; fi
  add dump OK "ultimo dump $(basename "$f") (${h} ore fa, integro)"
}
# 3. restic
check_offsite() {
  local repo pw out t e h
  repo="$(opsval RESTIC_REPOSITORY)"; pw="$(opsval RESTIC_PASSWORD_FILE)"
  if [ -z "$repo" ] || [ -z "$pw" ]; then add offsite AVVISO "copia fuori macchina NON configurata"; return; fi
  if ! command -v "$RESTIC" >/dev/null 2>&1; then add offsite AVVISO "restic non installato"; return; fi
  export_ops_prefix RESTIC_ AWS_ B2_ AZURE_ GOOGLE_ OS_ ST_
  export RESTIC_REPOSITORY="$repo" RESTIC_PASSWORD_FILE="$pw"
  if ! out="$("$RESTIC" snapshots --tag soldi --json 2>/dev/null)"; then add offsite ERRORE "repository restic non raggiungibile"; return; fi
  t="$(printf '%s' "$out" | grep -oE '"time":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | sed 's/"time":"//; s/T/ /' | sort | tail -n 1)" || true
  [ -n "$t" ] || { add offsite ERRORE "nessuno snapshot restic con tag soldi"; return; }
  e="$(to_epoch "$t")"; h="$(hours_since "$e")"
  if [ "$h" -gt "$MAX_OFFSITE_H" ]; then add offsite ERRORE "ultimo snapshot restic vecchio di ${h} ore (soglia ${MAX_OFFSITE_H})"; return; fi
  add offsite OK "ultimo snapshot restic di ${h} ore fa"
}
# 4. spazio
check_disk() {
  local free
  free="$(disk_free_pct "$BACKUPS_DIR")"
  if [ "$free" -lt 5 ]; then add disk ERRORE "spazio libero ${free}% sul disco dei backup"
  elif [ "$free" -lt "$MIN_FREE" ]; then add disk AVVISO "spazio libero ${free}% sul disco dei backup (soglia ${MIN_FREE}%)"
  else add disk OK "spazio libero ${free}% sul disco dei backup"; fi
}
# 5. prova di ripristino
check_restore_test() {
  local f ok fin d
  f="$STATE_DIR/restore-test.json"
  [ -f "$f" ] || { add restoretest AVVISO "la prova di ripristino non è mai stata eseguita"; return; }
  ok="$(state_field restore-test ok)"; fin="$(state_field restore-test finishedAt)"
  if [ "$ok" != true ]; then add restoretest ERRORE "l'ultima prova di ripristino è FALLITA ($fin)"; return; fi
  d=$(( ( $(now_epoch) - $(iso_to_epoch "$fin") ) / 86400 ))
  if [ "$d" -gt "$MAX_RT_DAYS" ]; then add restoretest AVVISO "ultima prova di ripristino di ${d} giorni fa (soglia ${MAX_RT_DAYS})"; return; fi
  add restoretest OK "ultima prova di ripristino riuscita ${d} giorni fa"
}

check_app; check_dump; check_offsite; check_disk; check_restore_test

# --- esito e notifiche -------------------------------------------------------
LAST="$STATE_DIR/backup-check.last"
worst=0; summary=""
NEW=""
while IFS='|' read -r name level msg; do
  [ -n "$name" ] || continue
  case "$level" in
    OK)      printf '  OK       %s\n' "$msg"; sym=OK ;;
    AVVISO)  printf '  AVVISO   %s\n' "$msg"; sym=AVVISO; [ "$worst" -lt 1 ] && worst=1 ;;
    ERRORE)  printf '  ERRORE   %s\n' "$msg"; sym=ERRORE; worst=2 ;;
  esac
  prev="$(sed -n "s/^$name=//p" "$LAST" 2>/dev/null | head -n 1 || true)"
  NEW="${NEW}${name}=${sym}"$'\n'
  if [ "$sym" != OK ]; then
    summary="${summary:+$summary; }$msg"
    lvl=warn; [ "$sym" = ERRORE ] && lvl=error
    notify "Controllo backup: $msg" "$lvl" "bc-$name-$sym" 24
  elif [ -n "$prev" ] && [ "$prev" != OK ]; then
    notify "Controllo backup rientrato: $msg" info
    rm -f "$STATE_DIR/notify-bc-$name-AVVISO.stamp" "$STATE_DIR/notify-bc-$name-ERRORE.stamp"
  fi
done <<< "$RESULTS"
printf '%s' "$NEW" > "$LAST"

details="$(printf '{"results":[%s]}' "$(printf '%s' "$RESULTS" | awk -F'|' 'NF>=3 { gsub(/\\/, "\\\\", $3); gsub(/"/, "\\\"", $3); printf "%s{\"check\":\"%s\",\"level\":\"%s\",\"message\":\"%s\"}", (n++ ? "," : ""), $1, $2, $3 }')")"
case "$worst" in
  0) job_finish ok "Tutti i controlli dei backup sono ok." "$details" ;;
  1) job_finish warn "Controllo backup: $summary" "$details" ;;
  *) job_finish fail "Controllo backup: $summary" "$details" ;;
esac
