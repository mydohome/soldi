#!/usr/bin/env bash
# ops/lib.sh — libreria comune degli script di gestione di Soldi.
# Da includere con `.` (non da eseguire). Compatibile con bash 3.2 (macOS) e 5.x.
#
# Contratto verso gli script:
#   . "$OPS_DIR/lib.sh"; detect_layout; choose_compose; job_begin <nome> ...
# Variabili d'ambiente utili ai test: DC e DOCKER (sostituibili con stub),
# OPS_NOW (orologio finto, epoch), SOLDI_HOME (cartella di deploy), OPS_ENV (ops.env).
# shellcheck shell=bash
# shellcheck disable=SC2034  # variabili esportate agli script che includono la libreria

set -euo pipefail
umask 077

if [ -z "${OPS_DIR:-}" ]; then
  OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
# Cartella da cui lo script è stato invocato (utile se è un link simbolico nella
# cartella di deploy: ln -s app/ops/soldi ./soldi).
OPS_INVOKED_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

# ------------------------------------------------------------------ log
if [ -t 2 ]; then
  C_INFO=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi
_ts() { date '+%Y-%m-%d %H:%M:%S'; }
# Tutto su stderr: stdout resta pulito per i valori restituiti con $(...).
log()  { printf '%s %s▸ %s%s\n' "$(_ts)" "$C_INFO" "$*" "$C_OFF" >&2; }
ok()   { printf '%s %s✓ %s%s\n' "$(_ts)" "$C_OK" "$*" "$C_OFF" >&2; }
warn() { printf '%s %s! %s%s\n' "$(_ts)" "$C_WARN" "$*" "$C_OFF" >&2; }
err()  { printf '%s %s✗ %s%s\n' "$(_ts)" "$C_ERR" "$*" "$C_OFF" >&2; }
# Dentro un job il messaggio finisce in ops-state/<job>.json e nella notifica.
die()  { err "$*"; JOB_ERR="$*"; exit 1; }

# ------------------------------------------------------------------ tempo / file
if date --version >/dev/null 2>&1; then DATE_GNU=1; else DATE_GNU=0; fi
if stat -c %Y / >/dev/null 2>&1; then STAT_GNU=1; else STAT_GNU=0; fi

now_epoch() { if [ -n "${OPS_NOW:-}" ]; then printf '%s\n' "$OPS_NOW"; else date +%s; fi; }
iso_utc() {
  if [ "$DATE_GNU" = 1 ]; then date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'; else date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ'; fi
}
# "YYYY-MM-DD HH:MM:SS" (ora locale) -> epoch
to_epoch() {
  if [ "$DATE_GNU" = 1 ]; then date -d "$1" +%s; else date -j -f '%Y-%m-%d %H:%M:%S' "$1" +%s; fi
}
# ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ) -> epoch
iso_to_epoch() {
  if [ "$DATE_GNU" = 1 ]; then date -u -d "$1" +%s; else date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; fi
}
file_mtime() { if [ "$STAT_GNU" = 1 ]; then stat -c %Y "$1"; else stat -f %m "$1"; fi; }
file_mode()  { if [ "$STAT_GNU" = 1 ]; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
age_hours() { local m; m="$(file_mtime "$1")"; echo $(( ( $(now_epoch) - m ) / 3600 )); }
disk_free_pct() { df -Pk "$1" | awk 'NR==2 { sub(/%/, "", $5); print 100 - $5 }'; }
rand_hex() { od -An -N"${1:-6}" -tx1 /dev/urandom | tr -d ' \n'; }

# ------------------------------------------------------------------ .env / ops.env
# Legge KEY da un file NAME=VALORE senza mai eseguirlo: ignora commenti e righe
# vuote, accetta `export`, spazi attorno a `=`, valori tra apici singoli o doppi
# (nessuna sostituzione di variabili o escape), commento finale ` # …` sui valori
# senza apici. L'ultima definizione vince. Stampa il valore (anche vuoto).
read_kv() {
  [ -f "$1" ] || return 0
  awk -v key="$2" '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*#/) next
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      i = index(line, "=")
      if (i == 0) next
      k = substr(line, 1, i - 1)
      gsub(/[[:space:]]+$/, "", k)
      if (k != key) next
      v = substr(line, i + 1)
      sub(/^[[:space:]]+/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == "\047") {
        rest = substr(v, 2)
        j = index(rest, q)
        v = (j > 0) ? substr(rest, 1, j - 1) : rest
      } else {
        sub(/[[:space:]]+#.*$/, "", v)
        sub(/[[:space:]]+$/, "", v)
      }
      last = v
      found = 1
    }
    END { if (found) print last }
  ' "$1"
}
envval() { read_kv "$COMPOSE_DIR/.env" "$1"; }
# ops.env: la variabile d'ambiente con lo stesso nome, se impostata, ha la precedenza.
opsval() {
  local v="${!1-}"
  if [ -n "$v" ]; then printf '%s' "$v"; else read_kv "$OPS_ENV_FILE" "$1"; fi
}
# Esporta nell'ambiente le variabili di ops.env che iniziano con uno dei prefissi
# (credenziali dei backend restic: AWS_, B2_, RESTIC_, …), senza mai usare `source`.
export_ops_prefix() {
  local prefix key val
  [ -f "$OPS_ENV_FILE" ] || return 0
  for prefix in "$@"; do
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      [ -z "${!key-}" ] || continue   # la variabile d'ambiente ha la precedenza
      val="$(read_kv "$OPS_ENV_FILE" "$key")"
      # shellcheck disable=SC2163
      export "$key=$val"
    done < <(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\(${prefix}[A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p" "$OPS_ENV_FILE" | sort -u)
  done
}

# ------------------------------------------------------------------ layout
layout_ok() {
  [ -f "$1/.env" ] || return 1
  [ -f "$1/docker-compose.yml" ] && return 0
  [ -n "${COMPOSE_FILE:-}" ] && [ -f "$1/${COMPOSE_FILE%%:*}" ] && return 0
  return 1
}
# COMPOSE_DIR = cartella con docker-compose.yml e .env; APP_DIR = checkout git.
# Ordine: --home/SOLDI_HOME, cartella corrente, cartella da cui è stato invocato lo
# script (link simbolico), poi risalendo dalla posizione reale dello script.
detect_layout() {
  local home="${SOLDI_HOME_ARG:-${SOLDI_HOME:-}}" d
  COMPOSE_DIR=""
  if [ -n "$home" ]; then
    [ -d "$home" ] || die "Cartella non trovata: $home"
    COMPOSE_DIR="$(cd "$home" && pwd)"
    layout_ok "$COMPOSE_DIR" || die "In $COMPOSE_DIR mancano docker-compose.yml e/o .env."
  elif layout_ok "$PWD"; then
    COMPOSE_DIR="$PWD"
  elif [ -n "$OPS_INVOKED_DIR" ] && layout_ok "$OPS_INVOKED_DIR"; then
    COMPOSE_DIR="$OPS_INVOKED_DIR"
  else
    d="$OPS_DIR"
    while [ "$d" != "/" ]; do
      d="$(dirname "$d")"
      if layout_ok "$d"; then COMPOSE_DIR="$d"; break; fi
    done
  fi
  [ -n "$COMPOSE_DIR" ] || die "Non trovo la cartella di Soldi (quella con docker-compose.yml e .env). Usa --home <cartella> o SOLDI_HOME."

  apply_layout
}
# Deriva le cartelle dal COMPOSE_DIR già scelto (usata anche da dr.sh, che può partire
# da una cartella ancora senza .env).
apply_layout() {
  if [ -d "$COMPOSE_DIR/app/.git" ]; then LAYOUT=deploy; APP_DIR="$COMPOSE_DIR/app"; else LAYOUT=repo; APP_DIR="$COMPOSE_DIR"; fi
  BACKUPS_DIR="$COMPOSE_DIR/backups"
  DUMPS_DIR="$BACKUPS_DIR/dumps"
  STATE_DIR="$COMPOSE_DIR/ops-state"
  OPS_ENV_FILE="${OPS_ENV:-$COMPOSE_DIR/ops.env}"
  if [ -z "${OPS_DRY_RUN:-}" ]; then
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR" 2>/dev/null || true
  fi
  # Gli script lanciati da qui (notify.sh, offsite.sh…) ritrovano la stessa cartella.
  export SOLDI_HOME="$COMPOSE_DIR"
  cd "$COMPOSE_DIR"
}

# Parte comune dello stato locale; scrive un avviso se ops.env è leggibile da altri.
check_ops_env_perms() {
  [ -f "$OPS_ENV_FILE" ] || return 0
  case "$(file_mode "$OPS_ENV_FILE")" in
    600|400) ;;
    *) warn "ops.env ha permessi troppo aperti: esegui  chmod 600 \"$OPS_ENV_FILE\"" ;;
  esac
}

# Comando compose: DC se impostato (test), altrimenti `docker compose` o `docker-compose`.
# $DC va usato SENZA virgolette (può contenere uno spazio).
choose_compose() {
  DOCKER="${DOCKER:-docker}"
  if [ -n "${DC:-}" ]; then return 0; fi
  if "$DOCKER" compose version >/dev/null 2>&1; then
    DC="$DOCKER compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
  else
    die "Docker Compose non disponibile."
  fi
}

# ------------------------------------------------------------------ JSON / stato dei job
json_str() {
  local s="$1"
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# state_write <job> <ok|fail|warn> "<messaggio>" [json-dettagli]
# Scrive in modo atomico ops-state/<job>.json. Contratto stabile (version 1):
#   {"version":1,"job":"backup","ok":true,"status":"ok","startedAt":"…Z","finishedAt":"…Z",
#    "durationMs":1234,"message":"…","details":{}}
# ok è false solo per "fail" (un avviso è ok:true, status:"warn"). durationMs ha
# risoluzione di un secondo.
state_write() {
  local job="$1" status="$2" msg="$3" details="${4-}" start fin okv tmp
  [ -n "$details" ] || details='{}'
  case "$status" in ok|warn) okv=true ;; fail) okv=false ;; *) die "state_write: stato non valido: $status" ;; esac
  fin="$(now_epoch)"
  if [ "${JOB_NAME:-}" = "$job" ] && [ -n "${JOB_START:-}" ]; then start="$JOB_START"; else start="$fin"; fi
  mkdir -p "$STATE_DIR"
  tmp="$STATE_DIR/.$job.json.$$"
  printf '{"version":1,"job":%s,"ok":%s,"status":"%s","startedAt":"%s","finishedAt":"%s","durationMs":%s,"message":%s,"details":%s}\n' \
    "$(json_str "$job")" "$okv" "$status" "$(iso_utc "$start")" "$(iso_utc "$fin")" \
    $(( (fin - start) * 1000 )) "$(json_str "$msg")" "$details" > "$tmp"
  mv -f "$tmp" "$STATE_DIR/$job.json"
}
# Campo semplice dal JSON di stato (che scriviamo noi, su una riga): state_field <job> <campo>
state_field() {
  local f="$STATE_DIR/$1.json" m
  [ -f "$f" ] || return 0
  m="$(grep -oE "\"$2\":(\"[^\"]*\"|[^,}]*)" "$f" | head -n 1)" || true
  m="${m#*:}"; m="${m#\"}"; m="${m%\"}"
  printf '%s' "$m"
}

# ------------------------------------------------------------------ lock
# flock se disponibile; altrimenti una directory atomica con il pid (stesso effetto).
# lock_try <nome>: come lock_acquire ma restituisce 1 invece di terminare (cron frequenti).
lock_try() {
  local name="$1" f="$COMPOSE_DIR/.$1.lock" pid
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$f"
    flock -n 9
    return $?
  fi
  LOCK_DIR="$f.d"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then LOCK_DIR=""; return 1; fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { LOCK_DIR=""; return 1; }
  fi
  echo "$$" > "$LOCK_DIR/pid"
}
lock_acquire() { lock_try "$1" || die "Un altro processo \"$1\" è già in corso."; }
lock_release() {
  if [ -n "${LOCK_DIR:-}" ]; then rm -rf "$LOCK_DIR"; LOCK_DIR=""; fi
}

# ------------------------------------------------------------------ job (stato, notifiche, ping)
# job_begin <nome>: avvia il job. Se lo script termina con un errore senza aver
# chiamato job_finish, l'uscita registra comunque stato "fail", notifica e ping /fail.
job_begin() {
  JOB_NAME="$1"; JOB_START="$(now_epoch)"; JOB_DONE=0; JOB_ERR=""
  trap job_on_exit EXIT
  trap 'JOB_ERR="interrotto da un segnale"; exit 130' INT TERM
  hc_ping start
}
_job_record() { # status msg [details]
  local key fin
  state_write "$JOB_NAME" "$1" "$2" "${3-}"
  case "$1" in
    fail) hc_ping fail ;;
    *)    hc_ping ok ;;
  esac
  # La stessa chiave serve a watch.sh: chi arriva primo notifica, l'altro tace.
  fin="$(state_field "$JOB_NAME" finishedAt)"
  key="$1-$JOB_NAME-$(printf '%s' "$fin" | tr -c 'A-Za-z0-9' '-')"
  [ "${JOB_NO_NOTIFY:-0}" = 1 ] && return 0
  case "$1" in
    fail) notify "$2" error "$key" 100000 ;;
    warn) notify "$2" warn "$key" 100000 ;;
    ok)   [ "${JOB_NOTIFY_OK:-0}" = 1 ] && notify "$2" info || true ;;
  esac
}
# job_finish <ok|warn|fail> "<messaggio>" [json-dettagli]  → exit 0/2/1
job_finish() {
  local status="$1" msg="$2"
  JOB_DONE=1
  case "$status" in ok) ok "$msg" ;; warn) warn "$msg" ;; fail) err "$msg" ;; esac
  _job_record "$status" "$msg" "${3-}"
  case "$status" in ok) exit 0 ;; warn) exit 2 ;; *) exit 1 ;; esac
}
job_on_exit() {
  local rc=$?
  trap - EXIT
  if declare -F ops_cleanup >/dev/null 2>&1; then ops_cleanup || true; fi
  if [ "${JOB_DONE:-0}" != 1 ] && [ -n "${JOB_NAME:-}" ] && [ "$rc" -ne 0 ]; then
    JOB_DONE=1
    _job_record fail "${JOB_ERR:-terminato in modo imprevisto (codice $rc)}" || true
  fi
  lock_release
  exit "$rc"
}

# notify <messaggio> [livello] [chiave] [ore]   — mai fa fallire il chiamante
notify() {
  local msg="$1" level="${2:-info}" key="${3:-}" hours="${4:-}"
  local args=(--level "$level" --job "${JOB_NAME:-ops}")
  if [ -n "$key" ]; then args+=(--key "$key"); fi
  if [ -n "$hours" ]; then args+=(--once-per "$hours"); fi
  "$OPS_DIR/notify.sh" "$msg" "${args[@]}" || true
}

# Ping dell'"interruttore del morto" (es. healthchecks.io). L'URL è un segreto: viaggia
# su stdin di curl (-K -), mai negli argomenti. Per ogni job si può usare
# HC_PING_URL_<JOB> (BACKUP, OFFSITE, RESTORE_TEST); in mancanza vale HC_PING_URL.
# hc_ping <start|ok|fail> [NOME_VARIABILE]
hc_ping() {
  local kind="$1" var="${2:-}" url suffix=""
  if [ -z "$var" ]; then
    case "${JOB_NAME:-}" in
      backup|offsite|restore-test) ;;
      *) return 0 ;;
    esac
    var="HC_PING_URL_$(printf '%s' "$JOB_NAME" | tr 'a-z-' 'A-Z_')"
    url="$(opsval "$var")"
    [ -n "$url" ] || url="$(opsval HC_PING_URL)"
  else
    url="$(opsval "$var")"
  fi
  [ -n "$url" ] || return 0
  case "$kind" in start) suffix=/start ;; fail) suffix=/fail ;; esac
  printf 'url = "%s"\n' "$(curl_escape "${url%/}$suffix")" \
    | "${CURL:-curl}" -fsS -m 10 --retry 2 -o /dev/null -K - >/dev/null 2>&1 || true
}
# Escape per i valori tra virgolette in un file di configurazione di curl.
curl_escape() {
  local s="$1"
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}; s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# ------------------------------------------------------------------ docker / app
web_running() { $DC ps --status running --services 2>/dev/null | grep -x web >/dev/null; }

WEB_HEALTH_JS='fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
# Sonda dell'endpoint di salute dall'interno del container web.
web_probe() { $DC exec -T web node -e "$WEB_HEALTH_JS" >/dev/null 2>&1; }

# Stato di salute di un servizio (web|db): healthy|unhealthy|starting|none|down
service_health() {
  local c st
  c="$($DC ps -q "$1" 2>/dev/null || true)"
  [ -n "$c" ] || { echo down; return 0; }
  st="$("$DOCKER" inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{else}}down{{end}}' "$c" 2>/dev/null || echo down)"
  echo "$st"
}

# Attende che web sia sano. Usa l'HEALTHCHECK del container; se manca, la sonda di
# riserva. HEALTH_TRIES e HEALTH_SLEEP (default 40 × 2 s) servono ai test.
wait_healthy() {
  local status i
  for ((i = 0; i < ${HEALTH_TRIES:-40}; i++)); do
    status="$(service_health web)"
    case "$status" in
      healthy)   return 0 ;;
      unhealthy) return 1 ;;
      none)      web_probe && return 0 ;;
    esac
    sleep "${HEALTH_SLEEP:-2}"
  done
  return 1
}

PGUSER_ENV() { local v; v="$(envval PGUSER)"; echo "${v:-soldi}"; }
PGDATABASE_ENV() { local v; v="$(envval PGDATABASE)"; echo "${v:-soldi}"; }

# Il dump finisce con "-- PostgreSQL database dump complete" (le versioni recenti
# di pg_dump aggiungono dopo un \unrestrict: si guardano le ultime righe).
verify_dump() {
  local f="$1" tail_out
  [ -s "$f" ] || return 1
  gzip -t "$f" 2>/dev/null || return 1
  tail_out="$(gzip -dc "$f" 2>/dev/null | tail -n 10)"
  case "$tail_out" in *"-- PostgreSQL database dump complete"*) return 0 ;; *) return 1 ;; esac
}
# dump_db <destinazione.sql.gz>: pg_dump compresso, verificato, permessi 600.
dump_db() {
  local dest="$1" tmp="$1.tmp"
  mkdir -p "$(dirname "$dest")"
  chmod 700 "$(dirname "$dest")" 2>/dev/null || true
  rm -f "$tmp"
  if $DC exec -T db pg_dump -U "$(PGUSER_ENV)" --clean --if-exists "$(PGDATABASE_ENV)" | gzip > "$tmp" && verify_dump "$tmp"; then
    mv -f "$tmp" "$dest"
    chmod 600 "$dest"
  else
    rm -f "$tmp" "$dest"
    return 1
  fi
}
# prune_keep <cartella> <glob> <quanti>: tiene i più recenti
prune_keep() {
  local dir="$1" pat="$2" keep="$3" f n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then rm -f -- "$f"; fi
  done < <(ls -1t "$dir"/$pat 2>/dev/null || true)
}

# ------------------------------------------------------------------ manifest / backup applicativi
manifest_flat() { tr -d ' \n\r\t' < "$1"; }
# manifest_rows <manifest.json> <tabella>
manifest_rows() { manifest_flat "$1" | sed -n 's/.*"'"$2"'":{"rows":\([0-9][0-9]*\).*/\1/p'; }
# righe "tabella righe" per ogni tabella del manifest
manifest_tables() { manifest_flat "$1" | grep -o '"[a-z_]*":{"rows":[0-9]*' | sed 's/^"\([a-z_]*\)":{"rows":\([0-9]*\)$/\1 \2/'; }
manifest_value() { manifest_flat "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' | head -n 1; }

# Cartella del backup applicativo globale più recente (per timestamp, non per nome:
# i backup vecchi hanno 19 caratteri di timestamp, i nuovi 23).
latest_app_backup() { # [cartella-backups]
  local root="${1:-$BACKUPS_DIR}" d n ts
  for d in "$root"/soldi-backup-*; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"; ts="${n#soldi-backup-}"
    if [ "${#ts}" -eq 19 ]; then ts="$ts-000"; fi
    printf '%s %s\n' "$ts" "$d"
  done | sort | tail -n 1 | cut -d' ' -f2-
}

# Ultimo file che corrisponde al glob (per data di modifica); vuoto se non c'è.
latest_file() { # <cartella> <glob>
  ls -1t "$1"/$2 2>/dev/null | head -n 1 || true
}

# ------------------------------------------------------------------ restic
# restic_configured: 0 se ops.env ha repository e file password e il comando esiste.
restic_configured() {
  RESTIC="${RESTIC:-restic}"
  [ -n "$(opsval RESTIC_REPOSITORY)" ] && [ -n "$(opsval RESTIC_PASSWORD_FILE)" ] && command -v "$RESTIC" >/dev/null 2>&1
}
# Esporta le variabili di restic (repository, file password, credenziali del backend).
restic_export_env() {
  export_ops_prefix RESTIC_ AWS_ B2_ AZURE_ GOOGLE_ OS_ ST_
  RESTIC_REPOSITORY="$(opsval RESTIC_REPOSITORY)"; export RESTIC_REPOSITORY
  RESTIC_PASSWORD_FILE="$(opsval RESTIC_PASSWORD_FILE)"; export RESTIC_PASSWORD_FILE
}
# Cartella (assoluta) che contiene l'ultimo backup applicativo dentro un albero
# ripristinato da restic; vuota se non c'è.
find_backups_root() { # <cartella>
  local d
  d="$(find "$1" -type d -name 'soldi-backup-*' 2>/dev/null | head -n 1)" || true
  [ -n "$d" ] && dirname "$d" || true
}

# ------------------------------------------------------------------ barriere del ripristino di prova
# Nomi dei container di PRODUZIONE (web, db e i nomi noti), separati da spazi.
prod_container_names() {
  local svc cid name names="soldi-web soldi-db"
  for svc in web db; do
    cid="$($DC ps -q "$svc" 2>/dev/null || true)"
    [ -n "$cid" ] || continue
    name="$("$DOCKER" inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##' || true)"
    [ -n "$name" ] && names="$names $name"
  done
  echo "$names"
}
# assert_sandbox <db-temporaneo> <rete> <random> <PGHOST>
# Da chiamare PRIMA di ogni operazione distruttiva: abortisce se il database in uso
# non è il container temporaneo, se coincide con uno di produzione, se la rete non è
# isolata o se in rete c'è un container estraneo o uno di produzione.
# Richiede PROD_NAMES (prod_container_names).
assert_sandbox() {
  local db="$1" net="$2" rand="$3" pghost="$4" prod members m nets
  case "$db" in "soldi-restoretest-$rand") ;; *) die "BARRIERA: il database di prova non ha il nome atteso ($db): rifiuto di proseguire." ;; esac
  [ "$pghost" = "$db" ] || die "BARRIERA: PGHOST ($pghost) non è il container temporaneo ($db): rifiuto di proseguire."
  for prod in ${PROD_NAMES:-soldi-web soldi-db}; do
    { [ "$prod" != "$db" ] && [ "$prod" != "$pghost" ]; } || die "BARRIERA: il database di prova coincide con un container di produzione ($prod)."
  done
  [ "$("$DOCKER" network inspect -f '{{.Internal}}' "$net" 2>/dev/null || true)" = true ] \
    || die "BARRIERA: la rete di prova $net non è isolata (--internal): rifiuto di proseguire."
  members="$("$DOCKER" network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net" 2>/dev/null || true)"
  for m in $members; do
    case "$m" in
      "$db"|"soldi-restoretest-run-$rand"*) ;;
      *) die "BARRIERA: sulla rete di prova c'è un container estraneo ($m): rifiuto di proseguire." ;;
    esac
  done
  for prod in ${PROD_NAMES:-soldi-web soldi-db}; do
    nets="$("$DOCKER" inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$prod" 2>/dev/null || true)"
    case " $nets " in *" $net "*) die "BARRIERA: il container di produzione $prod è collegato alla rete di prova." ;; esac
  done
}

# ------------------------------------------------------------------ ripristino applicativo
# restore_in_container <nome-backup> [--migrate]
# Esegue restore.js in un container usa-e-getta della STESSA immagine e delle stesse reti
# del servizio web (docker compose run --no-deps). <nome-backup> è una cartella dentro
# backups/ (visibile nel container come /app/backups). Con --migrate crea prima lo schema
# (database nuovo).
restore_in_container() {
  local name="$1" migrate="${2:-}"
  if [ "$migrate" = --migrate ]; then
    $DC run --rm --no-deps -T web node src/db/migrate.js >&2 || return 1
  fi
  $DC run --rm --no-deps -T web node src/backup/restore.js "/app/backups/$name" --yes >&2
}
# diagnostica nel container web, se l'immagine la contiene (scripts/diag.js: richiede una
# ricostruzione dopo l'introduzione). 0 ok, 1 errori, 2 avvisi, 3 non disponibile.
run_diag() {
  $DC exec -T web test -f scripts/diag.js >/dev/null 2>&1 || return 3
  $DC exec -T web npm run diag --silent >&2
}
# Conferma digitata: confirm_typed <parola> <messaggio>; legge da stdin.
confirm_typed() {
  local word="$1" answer=""
  printf '%s\n  Per confermare scrivi %s: ' "$2" "$word" >&2
  IFS= read -r answer || answer=""
  [ "$answer" = "$word" ]
}

# set_kv <file> <CHIAVE> <valore>: imposta CHIAVE=valore in un file .env (sostituisce la riga
# esistente o aggiunge in coda); il valore passa per l'ambiente di awk, senza escape.
set_kv() {
  local tmp="$1.tmp.$$"
  V="$3" awk -v key="$2" '
    BEGIN { v = ENVIRON["V"]; done = 0 }
    {
      line = $0; k = line; sub(/^[[:space:]]*/, "", k); i = index(k, "=")
      name = (i > 0) ? substr(k, 1, i - 1) : ""
      gsub(/[[:space:]]+$/, "", name)
      if (name == key && !done) { print key "=" v; done = 1; next }
      print
    }
    END { if (!done) print key "=" v }
  ' "$1" > "$tmp"
  mv -f "$tmp" "$1"
}

# ------------------------------------------------------------------ macchina a stati degli avvisi (watch.sh)
# Per ogni controllo: fails (fallimenti consecutivi), since (inizio del guasto), lastAlert,
# alerted. Regole: si segnala solo dopo 2 controlli consecutivi falliti; poi un promemoria
# ogni 6 ore; al rientro un messaggio "ripristinato" con la durata del guasto.
# Lo stato sta nei "details" di ops-state/watch.json (formato rigido, riletto con grep).
SM_IDS=""
SM_REMIND_SECS=$((6 * 3600))
SM_MIN_FAILS=2

fmt_duration() { # secondi
  local s="$1"
  if [ "$s" -lt 120 ]; then echo "${s} s"
  elif [ "$s" -lt 7200 ]; then echo "$((s / 60)) min"
  else echo "$((s / 3600)) h $(( (s % 3600) / 60 )) min"; fi
}
_sm_set() { printf -v "SM_$1_$2" '%s' "$3"; }
_sm_get() { local v="SM_$1_$2"; printf '%s' "${!v-}"; }
sm_known() { case " $SM_IDS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
# sm_load <file.json>: legge lo stato dei controlli dai details
sm_load() {
  local f="$1" id fa si la al
  SM_IDS=""
  [ -f "$f" ] || return 0
  while read -r id fa si la al; do
    [ -n "$id" ] || continue
    SM_IDS="$SM_IDS $id"
    _sm_set F "$id" "$fa"; _sm_set S "$id" "$si"; _sm_set L "$id" "$la"; _sm_set A "$id" "$al"
  done < <(grep -oE '"[a-z0-9_]+":\{"fails":[0-9]+,"since":[0-9]+,"lastAlert":[0-9]+,"alerted":(true|false)\}' "$f" \
           | sed -E 's/^"([a-z0-9_]+)":\{"fails":([0-9]+),"since":([0-9]+),"lastAlert":([0-9]+),"alerted":(true|false)\}$/\1 \2 \3 \4 \5/')
}
# sm_json: i controlli come oggetto JSON (per i details)
sm_json() {
  local id out="" sep=""
  for id in $SM_IDS; do
    out="$out$sep\"$id\":{\"fails\":$(_sm_get F "$id"),\"since\":$(_sm_get S "$id"),\"lastAlert\":$(_sm_get L "$id"),\"alerted\":$(_sm_get A "$id")}"
    sep=","
  done
  printf '{%s}' "$out"
}
# sm_eval <id> <ok|warn|err> "<messaggio>" "<suggerimento>"
sm_eval() {
  local id="$1" st="$2" msg="$3" hint="$4" now fa si la al lvl
  now="$(now_epoch)"
  if ! sm_known "$id"; then SM_IDS="$SM_IDS $id"; _sm_set F "$id" 0; _sm_set S "$id" 0; _sm_set L "$id" 0; _sm_set A "$id" false; fi
  fa="$(_sm_get F "$id")"; si="$(_sm_get S "$id")"; la="$(_sm_get L "$id")"; al="$(_sm_get A "$id")"
  if [ "$st" = ok ]; then
    if [ "$al" = true ]; then
      notify "Ripristinato: $msg (il problema è durato $(fmt_duration $((now - si))))." info
    fi
    fa=0; si=0; la=0; al=false
  else
    fa=$((fa + 1))
    [ "$fa" -ne 1 ] || si="$now"
    lvl=warn; [ "$st" = err ] && lvl=error
    if [ "$al" != true ] && [ "$fa" -ge "$SM_MIN_FAILS" ]; then
      notify "$msg${hint:+
Suggerimento: $hint}" "$lvl"
      al=true; la="$now"
    elif [ "$al" = true ] && [ $((now - la)) -ge "$SM_REMIND_SECS" ]; then
      notify "Promemoria — il problema dura da $(fmt_duration $((now - si))): $msg${hint:+
Suggerimento: $hint}" "$lvl"
      la="$now"
    fi
  fi
  _sm_set F "$id" "$fa"; _sm_set S "$id" "$si"; _sm_set L "$id" "$la"; _sm_set A "$id" "$al"
}
