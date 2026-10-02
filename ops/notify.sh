#!/usr/bin/env bash
# notify.sh "<messaggio>" [--level info|warn|error] [--key <chiave>] [--once-per <ore>] [--job <nome>]
#
# Invia un avviso Telegram con il bot di GESTIONE (ALERT_TG_TOKEN / ALERT_TG_CHAT in
# ops.env), distinto da quello che l'app usa per i backup degli utenti.
#  - Il token viaggia su stdin di curl (-K -), mai negli argomenti (visibili con ps).
#  - --key + --once-per: al massimo un invio ogni N ore per la stessa chiave.
#  - Se Telegram non è configurato scrive su stderr; se non è raggiungibile il
#    messaggio resta in ops-state/outbox/ e viene reinviato alla chiamata successiva
#    (massimo 50 messaggi, scadenza 48 ore). Esce sempre con 0.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

OUTBOX_MAX=50
OUTBOX_TTL=$((48 * 3600))

MSG=""; LEVEL=info; KEY=""; ONCE=""; JOB="${JOB_NAME:-ops}"; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --level)    LEVEL="${2:-}"; shift 2 ;;
    --key)      KEY="${2:-}"; shift 2 ;;
    --once-per) ONCE="${2:-}"; shift 2 ;;
    --job)      JOB="${2:-}"; shift 2 ;;
    --home)     SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          if [ -z "$MSG" ]; then MSG="$1"; shift; else echo "notify.sh: argomento sconosciuto: $1" >&2; exit 0; fi ;;
  esac
done
case "$LEVEL" in info|warn|error) ;; *) echo "notify.sh: livello non valido: $LEVEL" >&2; LEVEL=info ;; esac
[ -n "$MSG" ] || { echo "uso: notify.sh \"<messaggio>\" [--level …] [--key …] [--once-per ore]" >&2; exit 0; }
case "$ONCE" in ''|*[!0-9]*) ONCE="" ;; esac
KEY="$(printf '%s' "$KEY" | tr -c 'A-Za-z0-9._-' '_')"

export SOLDI_HOME_ARG
# Un errore di layout non deve far fallire il chiamante.
if ! (detect_layout) >/dev/null 2>&1; then
  echo "notify.sh: cartella di Soldi non trovata, messaggio non inviato: $MSG" >&2
  exit 0
fi
detect_layout

OUTBOX="$STATE_DIR/outbox"
TOKEN="$(opsval ALERT_TG_TOKEN)"
CHAT="$(opsval ALERT_TG_CHAT)"
API="$(opsval ALERT_TG_API)"; API="${API:-https://api.telegram.org}"

# --- anti-spam ---------------------------------------------------------------
NOW="$(now_epoch)"
if [ -n "$KEY" ] && [ -n "$ONCE" ]; then
  STAMP="$STATE_DIR/notify-$KEY.stamp"
  if [ -f "$STAMP" ]; then
    last="$(cat "$STAMP" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ $((NOW - last)) -lt $((ONCE * 3600)) ]; then exit 0; fi
  fi
fi

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "notify.sh: Telegram non configurato (ALERT_TG_TOKEN/ALERT_TG_CHAT in ops.env): [$LEVEL] $JOB: $MSG" >&2
  exit 0
fi

# --- invio --------------------------------------------------------------------
tg_send() { # testo
  local text="$1"
  printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' \
    "$(curl_escape "$API")" "$(curl_escape "$TOKEN")" "$(curl_escape "$CHAT")" "$(curl_escape "$text")" \
    | "${CURL:-curl}" -fsS -m 15 -o /dev/null -K - >/dev/null 2>&1
}

flush_outbox() {
  local f ts age text
  [ -d "$OUTBOX" ] || return 0
  for f in "$OUTBOX"/*.msg; do
    [ -f "$f" ] || continue
    ts="$(basename "$f" | cut -d- -f1)"
    case "$ts" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
    age=$((NOW - ts))
    if [ "$age" -gt "$OUTBOX_TTL" ]; then rm -f "$f"; continue; fi
    text="$(cat "$f")"
    if tg_send "(in ritardo) $text"; then rm -f "$f"; else return 1; fi
  done
  return 0
}

enqueue() { # testo
  local n oldest
  mkdir -p "$OUTBOX"; chmod 700 "$OUTBOX" 2>/dev/null || true
  while [ "$(find "$OUTBOX" -name '*.msg' | wc -l | tr -d ' ')" -ge "$OUTBOX_MAX" ]; do
    oldest="$(find "$OUTBOX" -name '*.msg' | sort | head -n 1)"
    rm -f "$oldest"
  done
  n="$OUTBOX/$NOW-$(rand_hex 3).msg"
  printf '%s' "$1" > "$n"
}

case "$LEVEL" in info) LABEL=INFO ;; warn) LABEL=AVVISO ;; error) LABEL=ERRORE ;; esac
HOST="$(hostname -s 2>/dev/null || hostname)"
BODY="${MSG//$TOKEN/***}"
TEXT="Soldi · $HOST · $JOB · $LABEL
$BODY"
TEXT="${TEXT:0:3500}"

sent=1
if flush_outbox; then
  tg_send "$TEXT" && sent=0 || sent=1
fi
if [ "$sent" -ne 0 ]; then
  enqueue "$TEXT"
  echo "notify.sh: Telegram non raggiungibile, messaggio in coda (ops-state/outbox)." >&2
fi
[ -n "${STAMP:-}" ] && printf '%s' "$NOW" > "$STAMP"
exit 0
