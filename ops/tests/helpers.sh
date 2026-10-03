#!/usr/bin/env bash
# Mini-framework di test per gli script di ops/ (nessuna dipendenza, bash 3.2+).
# Ogni file *_test.sh fa `. helpers.sh`, definisce funzioni test_* e chiama run_tests.
# shellcheck shell=bash
# shellcheck disable=SC2034
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_REAL="$(cd "$TESTS_DIR/.." && pwd)"
CURRENT=""
SB_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/soldi-ops-test.XXXXXX")"
SB_ROOT="$(cd "$SB_ROOT" && pwd -P)"
RESULTS="$SB_ROOT/results"; : > "$RESULTS"
trap 'rm -rf "$SB_ROOT"' EXIT

# I test girano in sottoshell (ambiente isolato): i risultati si contano su file.
_fail() { echo F >> "$RESULTS"; printf '  ✗ %s: %s\n' "$CURRENT" "$*"; }
_pass() { echo P >> "$RESULTS"; }
assert_eq() { if [ "$1" = "$2" ]; then _pass; else _fail "${3:-attesi uguali}: «$1» ≠ «$2»"; fi; }
assert_ne() { if [ "$1" != "$2" ]; then _pass; else _fail "${3:-attesi diversi}: «$1»"; fi; }
assert_contains() { case "$1" in *"$2"*) _pass ;; *) _fail "${3:-manca «$2»} in: ${1:0:400}" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) _fail "${3:-non dovrebbe contenere «$2»} in: ${1:0:400}" ;; *) _pass ;; esac; }
assert_file() { if [ -e "$1" ]; then _pass; else _fail "${2:-file mancante}: $1"; fi; }
assert_no_file() { if [ ! -e "$1" ]; then _pass; else _fail "${2:-file inatteso}: $1"; fi; }
assert_rc() { if [ "$1" -eq "$2" ]; then _pass; else _fail "${3:-codice di uscita}: atteso $2, ottenuto $1"; fi; }

# Crea una cartella di prova unica per ogni test.
new_sandbox() { SB="$(mktemp -d "$SB_ROOT/t.XXXXXX")"; SB="$(cd "$SB" && pwd -P)"; export SB; }

# Layout "deploy": $SB/soldi/{docker-compose.yml,.env,app/.git,app/ops -> ops reale}
make_deploy() {
  new_sandbox
  HOME_DIR="$SB/soldi"
  mkdir -p "$HOME_DIR/app" "$HOME_DIR/backups"
  : > "$HOME_DIR/docker-compose.yml"
  cat > "$HOME_DIR/.env" <<'ENV'
# commento
PGUSER="soldi_u"
PGDATABASE='soldi_db'
export JWT_SECRET = abc def # commento finale
SECRETS_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
EMPTY=
ENV
  git -C "$HOME_DIR/app" init -q
  git -C "$HOME_DIR/app" config user.email t@t; git -C "$HOME_DIR/app" config user.name t
  ln -s "$OPS_REAL" "$HOME_DIR/app/ops"
  export SOLDI_HOME="$HOME_DIR"
}
# Layout "repo": tutto nella stessa cartella.
make_repo() {
  new_sandbox
  HOME_DIR="$SB/repo"
  mkdir -p "$HOME_DIR/backups"
  : > "$HOME_DIR/docker-compose.yml"
  printf 'PGUSER=soldi\nPGDATABASE=soldi\n' > "$HOME_DIR/.env"
  git -C "$HOME_DIR" init -q
  git -C "$HOME_DIR" config user.email t@t; git -C "$HOME_DIR" config user.name t
  ln -s "$OPS_REAL" "$HOME_DIR/ops"
  export SOLDI_HOME="$HOME_DIR"
}

# make_stub <percorso> <corpo>: script eseguibile finto.
make_stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$1"; chmod +x "$1"; }

# Stub di curl: registra argomenti e stdin; esce con il codice in $CURL_RC_FILE (default 0).
make_curl_stub() { # <dir>
  mkdir -p "$1"
  CURL_ARGS="$1/curl.args"; CURL_STDIN="$1/curl.stdin"; CURL_RC_FILE="$1/curl.rc"
  : > "$CURL_ARGS"; : > "$CURL_STDIN"; echo 0 > "$CURL_RC_FILE"
  make_stub "$1/curl" "printf '%s\n' \"\$*\" >> '$CURL_ARGS'; cat >> '$CURL_STDIN'; printf -- '----\n' >> '$CURL_STDIN'; exit \"\$(cat '$CURL_RC_FILE')\""
  export CURL="$1/curl" CURL_ARGS CURL_STDIN CURL_RC_FILE
}

run_tests() {
  local name pass fail
  for name in $(declare -F | awk '{print $3}' | grep '^test_'); do
    CURRENT="$name"
    ( "$name" ) || { echo F >> "$RESULTS"; printf '  ✗ %s: il test è terminato con errore\n' "$name"; }
  done
  pass="$(grep -c P "$RESULTS" || true)"; fail="$(grep -c F "$RESULTS" || true)"
  printf '%s: %s controlli ok, %s falliti\n' "$(basename "$0")" "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

# ---------------------------------------------------------------- stub di docker compose / docker / restic
# make_stack <dir-sandbox>: crea stub eseguibili in $SB/bin e li espone con DC, DOCKER, RESTIC.
# Il comportamento si regola con file in $STUB_DIR (vedi i commenti degli stub).
make_stack() {
  STUB_DIR="$SB/stub"; mkdir -p "$STUB_DIR" "$SB/bin"
  export STUB_DIR STUB_BACKUPS="$HOME_DIR/backups"
  printf 'web\ndb\n' > "$STUB_DIR/running"
  : > "$STUB_DIR/dc.log"; : > "$STUB_DIR/docker.log"; : > "$STUB_DIR/restic.log"
  # docker compose
  make_stub "$SB/bin/dc" '
echo "$*" >> "$STUB_DIR/dc.log"
case "$*" in
  "ps --status running --services") cat "$STUB_DIR/running" ;;
  "ps -q web") echo cid-web ;;
  "ps -q db")  echo cid-db ;;
  "exec -T web npm run backup")
    [ -f "$STUB_DIR/fail_appbackup" ] && exit 1
    d="$STUB_BACKUPS/soldi-backup-$(date +%Y-%m-%d_%H-%M-%S)-$((RANDOM % 900 + 100))"
    mkdir -p "$d"; printf "{\n  \"app\": \"soldi\",\n  \"format\": 1,\n  \"label\": \"auto\",\n  \"createdAt\": \"2026-10-03T01:00:00.000Z\",\n  \"tables\": {\n    \"users\": { \"rows\": 2, \"file\": \"users.csv\" },\n    \"transactions\": { \"rows\": 10, \"file\": \"transactions.csv\" }\n  }\n}\n" > "$d/manifest.json" ;;
  "exec -T db pg_dump "*)
    mode="$(cat "$STUB_DIR/dump_mode" 2>/dev/null || echo ok)"
    case "$mode" in
      ok)      echo "SELECT 1;"; echo "-- PostgreSQL database dump complete" ;;
      corrupt) echo "SELECT 1;"; echo "-- dump interrotto" ;;
      fail)    echo "SELECT 1;"; exit 1 ;;
    esac ;;
  "up -d --build") echo "up -d --build GIT_SHA=$GIT_SHA" >> "$STUB_DIR/dc.log" ;;
  "run --rm --no-deps -T web node src/db/migrate.js") exit "$(cat "$STUB_DIR/migrate_rc" 2>/dev/null || echo 0)" ;;
  "run --rm --no-deps -T web node src/backup/restore.js "*) exit "$(cat "$STUB_DIR/restore_rc" 2>/dev/null || echo 0)" ;;
  "exec -T web test -f scripts/diag.js") exit "$(cat "$STUB_DIR/diag_present" 2>/dev/null || echo 1)" ;;
  "exec -T web npm run diag --silent") exit "$(cat "$STUB_DIR/diag_rc" 2>/dev/null || echo 0)" ;;
  "up -d web")
    [ -f "$STUB_DIR/fail_up_web" ] && exit 1
    exit 0 ;;
  "exec -T web node -e "*) exit "$(cat "$STUB_DIR/probe_rc" 2>/dev/null || echo 0)" ;;
  "exec -T db pg_isready "*) exit "$(cat "$STUB_DIR/pgready_rc" 2>/dev/null || echo 0)" ;;
  *) exit 0 ;;
esac'
  # docker (le risposte si regolano con file in $STUB_DIR)
  make_stub "$SB/bin/docker" '
echo "$*" >> "$STUB_DIR/docker.log"
created() { grep -o -e "--name [^ ]*" "$STUB_DIR/docker.log" | awk "{print \$2}" | tr "\n" " "; }
case "$1" in
  inspect)
    case "$*" in
      *"{{.Image}}"*) cat "$STUB_DIR/image" 2>/dev/null || echo sha256:testimage; exit 0 ;;
      *"{{.Name}}"*)  case "$*" in *cid-db*) echo /soldi-db ;; *) echo /soldi-web ;; esac; exit 0 ;;
      *".NetworkSettings.Networks"*) cat "$STUB_DIR/prod_networks" 2>/dev/null || echo "proxy-net backend "; exit 0 ;;
      *".RestartCount"*) case "$*" in *cid-db*) svc=db ;; *) svc=web ;; esac; cat "$STUB_DIR/restart_count.$svc" 2>/dev/null || echo 0; exit 0 ;;
    esac
    # stato di salute: sano, salvo che HEAD di $STUB_APP sia il commit "cattivo" indicato in bad_sha
    if [ -f "$STUB_DIR/bad_sha" ] && [ -n "${STUB_APP:-}" ] && [ "$(git -C "$STUB_APP" rev-parse HEAD)" = "$(cat "$STUB_DIR/bad_sha")" ]; then echo unhealthy; exit 0; fi
    case "$*" in *cid-db*) svc=db ;; *) svc=web ;; esac
    cat "$STUB_DIR/inspect.out.$svc" 2>/dev/null || cat "$STUB_DIR/inspect.out" 2>/dev/null || echo healthy ;;
  network)
    case "$2" in
      inspect)
        case "$*" in
          *"inspect proxy-net"*) exit "$(cat "$STUB_DIR/proxy_net_rc" 2>/dev/null || echo 1)" ;;
          *"{{.Internal}}"*) cat "$STUB_DIR/net_internal" 2>/dev/null || echo true ;;
          *) cat "$STUB_DIR/net_members" 2>/dev/null || created ;;
        esac ;;
      *) exit "$(cat "$STUB_DIR/network_rc" 2>/dev/null || echo 0)" ;;
    esac ;;
  run)
    case "$*" in
      *"node src/db/migrate.js"*) exit "$(cat "$STUB_DIR/migrate_rc" 2>/dev/null || echo 0)" ;;
      *"node src/backup/restore.js"*) exit "$(cat "$STUB_DIR/restore_rc" 2>/dev/null || echo 0)" ;;
      *"node scripts/diag.js"*) exit "$(cat "$STUB_DIR/diag_rc" 2>/dev/null || echo 0)" ;;
    esac ;;
  exec)
    case "$*" in
      *pg_isready*) exit "$(cat "$STUB_DIR/pgready_rc" 2>/dev/null || echo 0)" ;;
      *psql*) t="$(printf "%s" "$*" | sed -n "s/.*FROM \([a-z_]*\).*/\1/p")"; cat "$STUB_DIR/count.$t" 2>/dev/null || echo 0 ;;
    esac ;;
  info) echo "${STUB_DOCKER_ROOT:-/var/lib/docker}" ;;
  *) exit 0 ;;
esac'
  # restic: registra argomenti e le variabili rilevanti; esiti regolabili con restic.rc.<comando>
  make_stub "$SB/bin/restic" '
echo "$* | repo=${RESTIC_REPOSITORY:-} pw=${RESTIC_PASSWORD_FILE:-} aws=${AWS_ACCESS_KEY_ID:-}" >> "$STUB_DIR/restic.log"
cmd="$1"
rc="$(cat "$STUB_DIR/restic.rc.$cmd" 2>/dev/null || echo 0)"
if [ "$cmd" = snapshots ]; then cat "$STUB_DIR/restic.snapshots" 2>/dev/null || echo "[]"; fi
exit "$rc"'
  export DC="$SB/bin/dc" DOCKER="$SB/bin/docker" RESTIC="$SB/bin/restic"
  # il comando docker compose reale legge l'ambiente: per sicurezza niente PG* dell'utente
  unset PGUSER PGDATABASE PGPASSWORD
}
dc_log()     { cat "$STUB_DIR/dc.log"; }
docker_log() { cat "$STUB_DIR/docker.log"; }
restic_log() { cat "$STUB_DIR/restic.log"; }
count_files() { local n=0 f; for f in "$@"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
