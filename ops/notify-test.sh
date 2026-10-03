#!/usr/bin/env bash
# notify-test.sh — prova delle notifiche: un messaggio per ciascun livello (info, warn,
# error) con l'esito di ognuno, per verificare che il canale funzioni PRIMA di fidarsene.
#   --simulate-fault  finge un guasto del servizio e il rientro attraverso la vera macchina
#                     a stati di watch.sh (nessun servizio viene fermato)
# Uscita: 0 se tutti i messaggi sono partiti, 1 altrimenti (canale non configurato o giù).
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

SIM=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --simulate-fault) SIM=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
check_ops_env_perms

if [ -z "$(opsval ALERT_TG_TOKEN)" ] || [ -z "$(opsval ALERT_TG_CHAT)" ]; then
  err "Telegram NON è configurato: imposta ALERT_TG_TOKEN e ALERT_TG_CHAT in ops.env (vedi docs/OPERATIONS.md)."
  exit 1
fi

if [ "$SIM" = 1 ]; then exec "$OPS_DIR/watch.sh" --simulate-fault --home "$COMPOSE_DIR"; fi

bad=0
for level in info warn error; do
  out="$("$OPS_DIR/notify.sh" "Messaggio di prova ($level): se lo leggi, il canale funziona." --level "$level" --job notify-test --verbose 2>&1 || true)"
  case "$out" in
    *"messaggio inviato"*) ok "[$level] inviato" ;;
    *) err "[$level] NON inviato: ${out:-nessun dettaglio}"; bad=1 ;;
  esac
done
if [ "$bad" = 1 ]; then
  err "Almeno un messaggio non è partito (restano in ops-state/outbox e verranno reinviati alla prossima notifica)."
  exit 1
fi
ok "Tutti i messaggi sono partiti: controlla Telegram. Per provare gli avvisi di guasto: soldi notify-test --simulate-fault"
