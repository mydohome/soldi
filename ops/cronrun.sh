#!/usr/bin/env bash
# cronrun.sh — esegue un comando da cron con lock e log a rotazione semplice.
#   cronrun.sh <job> -- <comando> [argomenti…]
# Un solo esemplare per job alla volta (flock); l'output va in ops-state/<job>.log, ruotato oltre
# 1 MB (si tengono .log, .log.1 e .log.2). Uscita: quella del comando (se già in corso: 0).
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

JOB="${1:-}"; [ -n "$JOB" ] && [ "${2:-}" = "--" ] || { echo "uso: cronrun.sh <job> -- <comando…>" >&2; exit 1; }
shift 2
case "$JOB" in *[!A-Za-z0-9_-]*) echo "cronrun.sh: nome del job non valido" >&2; exit 1 ;; esac
SOLDI_HOME_ARG=""; export SOLDI_HOME_ARG
detect_layout

LOG="$STATE_DIR/$JOB.log"
if ! lock_try "cron-$JOB"; then echo "$(_ts) $JOB: già in corso, salto" >> "$LOG"; exit 0; fi
trap lock_release EXIT
MAX="${CRON_LOG_MAX_BYTES:-1048576}"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt "$MAX" ]; then
  [ ! -f "$LOG.1" ] || mv -f "$LOG.1" "$LOG.2"
  mv -f "$LOG" "$LOG.1"
fi
{ printf '\n=== %s %s ===\n' "$(_ts)" "$JOB"; } >> "$LOG"
rc=0
"$@" >> "$LOG" 2>&1 || rc=$?
printf '=== %s %s fine (codice %s) ===\n' "$(_ts)" "$JOB" "$rc" >> "$LOG"
exit "$rc"
