#!/usr/bin/env bash
# watch.sh — sorveglianza del servizio, pensata per girare ogni 5 minuti da cron.
# Leggero: nessuna scrittura sul database, una sola sonda per esecuzione (niente cicli di
# attesa). Controlla container web/db (in esecuzione e sani), pg_isready, endpoint di salute
# dell'app, riavvii a ripetizione (RestartCount), spazio su disco (backups e Docker),
# l'esito dei job (backup, offsite, restore-test, update) e il riavvio dell'host.
#
# Avvisi Telegram con una macchina a stati (ops-state/watch.json), per non essere subissati:
#   • un problema si segnala solo dopo 2 controlli consecutivi falliti (~10 minuti);
#   • finché dura, un promemoria ogni 6 ore;
#   • al rientro, un messaggio "ripristinato" con la durata del guasto.
# Con HC_PING_URL_WATCH in ops.env ogni esecuzione completata fa un ping all'esterno: se si
# ferma il cron o muore la macchina, l'avviso arriva dal servizio esterno.
#
# Uso: watch.sh [--simulate-fault] [--home <cartella>]
#   --simulate-fault  finge un guasto e il rientro attraverso la vera macchina a stati
#                     (stato separato, nessun servizio viene fermato)
# Uscita: 0 tutto ok, 2 avviso, 1 errore (la macchina a stati decide quando avvisare).
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

SIMULATE=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --simulate-fault) SIMULATE=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose

# ------------------------------------------------------------------ simulazione (G12)
if [ "$SIMULATE" = 1 ]; then
  JOB_NAME=watch
  SIM="$STATE_DIR/watch-sim.json"
  rm -f "$SIM"; sm_load "$SIM"
  say() { printf '  %s\n' "$*" >&2; }
  echo "Simulazione di un guasto (nessun servizio viene fermato; stato in ops-state/watch-sim.json):" >&2
  base="$(now_epoch)"
  M="SIMULAZIONE di guasto: il servizio finge di non rispondere"
  say "controllo 1: fallito → nessun messaggio (serve una conferma)"
  OPS_NOW="$base" sm_eval simulazione err "$M" "è solo una prova: non fare nulla"
  say "controllo 2: fallito → arriva l'avviso"
  OPS_NOW=$((base + 300)) sm_eval simulazione err "$M" "è solo una prova: non fare nulla"
  say "6 ore dopo: ancora guasto → arriva il promemoria"
  OPS_NOW=$((base + 300 + 6 * 3600)) sm_eval simulazione err "$M" "è solo una prova: non fare nulla"
  say "rientro → arriva il messaggio «ripristinato»"
  OPS_NOW=$((base + 300 + 6 * 3600 + 600)) sm_eval simulazione ok "SIMULAZIONE terminata: il servizio finto è di nuovo ok" ""
  rm -f "$SIM"
  echo "Fatto: devi aver ricevuto 3 messaggi (avviso, promemoria, ripristinato)." >&2
  exit 0
fi

# ------------------------------------------------------------------ esecuzione reale
# Se la precedente è ancora in corso (cron ogni 5 minuti) si salta in silenzio.
if ! lock_try watch; then echo "watch: un'altra esecuzione è in corso, salto." >&2; exit 0; fi
JOB_NO_NOTIFY=1     # gli avvisi li decide la macchina a stati, non l'uscita del job
job_begin watch

WSTATE="$STATE_DIR/watch.json"
sm_load "$WSTATE"
NOW="$(now_epoch)"
LAST_RUN="$(grep -oE '"lastRun":[0-9]+' "$WSTATE" 2>/dev/null | head -n 1 | cut -d: -f2 || true)"; LAST_RUN="${LAST_RUN:-0}"
prev_restart() { grep -oE "\"restarts\":\\{[^}]*\"$1\":[0-9]+" "$WSTATE" 2>/dev/null | grep -oE "\"$1\":[0-9]+" | tail -n 1 | cut -d: -f2 || true; }

WORST=0; LINES=""
# report <id> <ok|warn|err> "<messaggio>" "<suggerimento>"
report() {
  local id="$1" st="$2" msg="$3" hint="$4" tag
  sm_eval "$id" "$st" "$msg" "$hint"
  case "$st" in ok) tag="OK    " ;; warn) tag="AVVISO"; [ "$WORST" -ge 1 ] || WORST=1 ;; err) tag="ERRORE"; WORST=2 ;; esac
  printf '  %s  %s\n' "$tag" "$msg"
}

# --- container ---------------------------------------------------------------------------------
WEB_STATE="$(service_health web)"; DB_STATE="$(service_health db)"
for svc in web db; do
  if [ "$svc" = web ]; then st="$WEB_STATE"; else st="$DB_STATE"; fi
  case "$st" in
    healthy) report "svc_$svc" ok "container $svc in esecuzione e sano" "" ;;
    # senza HEALTHCHECK la sonda di riserva è il controllo successivo (db_ready / app_health):
    # niente doppioni di avviso per la stessa causa
    none)    report "svc_$svc" ok "container $svc in esecuzione (senza HEALTHCHECK: vale la sonda qui sotto)" "" ;;
    starting) report "svc_$svc" warn "container $svc in avvio (non ancora sano)" "soldi logs $svc" ;;
    unhealthy) report "svc_$svc" err "container $svc NON sano" "soldi logs $svc" ;;
    *)       report "svc_$svc" err "container $svc NON in esecuzione" "soldi logs $svc  ·  docker compose up -d" ;;
  esac
done

# pg_isready e endpoint di salute (solo se il container esiste: sennò sarebbe un doppione)
if [ "$DB_STATE" != down ]; then
  if $DC exec -T db pg_isready -U "$(PGUSER_ENV)" -d "$(PGDATABASE_ENV)" >/dev/null 2>&1; then report db_ready ok "PostgreSQL accetta connessioni" ""
  else report db_ready err "PostgreSQL non accetta connessioni (pg_isready)" "soldi logs db"; fi
fi
if [ "$WEB_STATE" != down ]; then
  if web_probe; then report app_health ok "l'endpoint /api/health risponde" ""
  else report app_health err "l'endpoint /api/health non risponde" "soldi logs web"; fi
fi

# --- riavvii a ripetizione ------------------------------------------------------------------------
RESTARTS=""
for svc in web db; do
  cid="$($DC ps -q "$svc" 2>/dev/null || true)"
  [ -n "$cid" ] || continue
  cur="$("$DOCKER" inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
  case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
  prev="$(prev_restart "$svc")"
  RESTARTS="${RESTARTS:+$RESTARTS,}\"$svc\":$cur"
  if [ -n "$prev" ] && [ "$cur" -gt "$prev" ]; then
    report "restarts_$svc" warn "il container $svc si è riavviato $((cur - prev)) volte dall'ultimo controllo (totale $cur)" "soldi logs $svc"
  else
    report "restarts_$svc" ok "nessun riavvio anomalo di $svc" ""
  fi
done

# --- spazio su disco ------------------------------------------------------------------------------
WARN_PCT="${DISK_WARN_PCT:-15}"; ERR_PCT="${DISK_ERR_PCT:-7}"
disk_check() { # id etichetta cartella
  local free
  free="$(disk_free_pct "$3" 2>/dev/null || true)"
  [ -n "$free" ] || return 0
  if [ "$free" -lt "$ERR_PCT" ]; then report "$1" err "spazio libero ${free}% sul disco $2" "libera spazio: docker system df  ·  ls -lh backups/dumps"
  elif [ "$free" -lt "$WARN_PCT" ]; then report "$1" warn "spazio libero ${free}% sul disco $2" "libera spazio: docker system df  ·  ls -lh backups/dumps"
  else report "$1" ok "spazio libero ${free}% sul disco $2" ""; fi
}
disk_check disk_backups "dei backup" "$BACKUPS_DIR"
droot="$("$DOCKER" info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
if [ -n "$droot" ] && [ -d "$droot" ]; then disk_check disk_docker "di Docker" "$droot"; fi

# --- esito dei job ----------------------------------------------------------------------------------
# Stessa chiave dei job (fail-<job>-<finishedAt>): chi arriva primo avvisa, l'altro tace.
for job in backup offsite restore-test update; do
  [ -f "$STATE_DIR/$job.json" ] || continue
  if [ "$(state_field "$job" ok)" = false ]; then
    fin="$(state_field "$job" finishedAt)"
    key="fail-$job-$(printf '%s' "$fin" | tr -c 'A-Za-z0-9' '-')"
    notify "Ultimo esito di \"$job\" FALLITO ($fin): $(state_field "$job" message)" error "$key" 100000
    printf '  ERRORE  ultimo esito di %s fallito (%s)\n' "$job" "$fin"
    WORST=2
  fi
done
find "$STATE_DIR" -name 'notify-*.stamp' -mtime +30 -delete 2>/dev/null || true

# --- riavvio dell'host -------------------------------------------------------------------------------
UPTIME_FILE="${OPS_PROC_UPTIME:-/proc/uptime}"
if [ -r "$UPTIME_FILE" ]; then
  up="$(cut -d' ' -f1 "$UPTIME_FILE" | cut -d. -f1)"
  case "$up" in ''|*[!0-9]*) up="" ;; esac
  if [ -n "$up" ] && [ "$up" -lt 600 ] && [ "$LAST_RUN" -gt 0 ] && [ "$LAST_RUN" -lt $((NOW - up)) ]; then
    notify "L'host è stato riavviato $(fmt_duration "$up") fa. Stato dei servizi: web $WEB_STATE, db $DB_STATE." info
    printf '  INFO    host riavviato %s fa\n' "$(fmt_duration "$up")"
  fi
fi

details="$(printf '{"lastRun":%s,"restarts":{%s},"checks":%s}' "$NOW" "$RESTARTS" "$(sm_json)")"
hc_ping ok HC_PING_URL_WATCH
case "$WORST" in
  0) job_finish ok "Tutti i controlli ok." "$details" ;;
  1) job_finish warn "Almeno un controllo in avviso." "$details" ;;
  *) job_finish fail "Almeno un controllo fallito (gli avvisi seguono la macchina a stati)." "$details" ;;
esac
