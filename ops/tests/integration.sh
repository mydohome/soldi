#!/usr/bin/env bash
# Test di integrazione con Docker REALE (usato dal job "ops-integration" della CI).
# Avvia uno stack in layout "deploy" (cartella temporanea con docker-compose.yml, .env, backups/ e
# app/ = copia del repository), poi:
#   1. crea un utente e dei dati;
#   2. ops/backup.sh → deve riuscire (backup applicativo + dump verificato);
#   3. ops/restore-test.sh → deve riuscire, senza lasciare container/reti e senza toccare il database;
#   4. corrompe un CSV del backup → restore-test.sh deve FALLIRE, ripulire tutto e lasciare intatto
#      il database di produzione di prova.
# Richiede docker, compose v2, git, openssl.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/soldi-it.XXXXXX")"
PROJECT="soldiit$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
export COMPOSE_PROJECT_NAME="$PROJECT"
FAILED=0

say() { printf '\n== %s\n' "$*"; }
check() { # descrizione, comando…
  local d="$1"; shift
  if "$@"; then printf '  ok   %s\n' "$d"; else printf '  FAIL %s\n' "$d"; FAILED=1; fi
}
teardown() {
  ( cd "$WORK" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1 ) || true
  docker ps -aq --filter 'name=soldi-restoretest' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter 'name=soldi-restoretest' | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap teardown EXIT

say "Preparo lo stack di prova in $WORK"
git clone --quiet --local "$REPO" "$WORK/app"
# include anche modifiche non ancora committate (esecuzioni locali)
( cd "$REPO" && tar --exclude=./node_modules --exclude=./.git --exclude=./backups --exclude=./ops-state --exclude='./.*.lock*' -cf - . ) | ( cd "$WORK/app" && tar -xf - )
mkdir -p "$WORK/backups"
PW="$(openssl rand -hex 12)"
cat > "$WORK/.env" <<ENV
PGUSER=soldi
PGDATABASE=soldi
PGPASSWORD=$PW
JWT_SECRET=$(openssl rand -hex 32)
SECRETS_KEY=$(openssl rand -hex 32)
BACKUP_ENABLED=false
RECURRING_ENABLED=false
ALLOW_REGISTRATION=true
TRUST_PROXY=0
TZ=Europe/Rome
ENV
chmod 600 "$WORK/.env"
cat > "$WORK/docker-compose.yml" <<YML
services:
  db:
    image: postgres:16-alpine
    container_name: ${PROJECT}-db
    environment:
      POSTGRES_USER: soldi
      POSTGRES_PASSWORD: ${PW}
      POSTGRES_DB: soldi
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U soldi -d soldi"]
      interval: 3s
      timeout: 3s
      retries: 20
  web:
    build: ./app
    container_name: ${PROJECT}-web
    user: "$(id -u):$(id -g)"
    env_file: .env
    environment:
      PGHOST: db
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./backups:/app/backups
      - ./app/src:/app/src
      - ./app/public:/app/public
YML

cd "$WORK"
docker compose up -d --build >/dev/null
say "Attendo che web sia sano"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-web" 2>/dev/null || true)" = healthy ] && break
  sleep 2
done
check "web è sano" test "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-web")" = healthy

say "Dati di prova"
docker compose exec -T web npm run user:create -- cittest 'PasswordProva123!' 'CI' >/dev/null
sql() { docker compose exec -T db psql -U soldi -d soldi -tAc "$1" | tr -d ' \r\n'; }
sql "INSERT INTO transactions (user_id,type,amount_cents,scope,note,occurred_on) SELECT id,'expense',100+g,'personal','prova '||g,CURRENT_DATE FROM users, generate_series(1,25) g WHERE email='cittest'" >/dev/null
USERS_BEFORE="$(sql 'SELECT count(*) FROM users')"; TX_BEFORE="$(sql 'SELECT count(*) FROM transactions')"
check "dati inseriti ($USERS_BEFORE utenti, $TX_BEFORE movimenti)" test "$TX_BEFORE" = 25

say "diagnostica e status"
rc=0; docker compose exec -T web npm run diag --silent -- --data-only >/dev/null || rc=$?
check "npm run diag --data-only esce con 0 (ottenuto $rc)" test "$rc" -eq 0
check "soldi status produce il quadro" bash -c "'$REPO/ops/status.sh' --home '$WORK' 2>&1 | grep -q 'Soldi — stato'" 

say "backup.sh"
rc=0; "$REPO/ops/backup.sh" --home "$WORK" || rc=$?
check "backup.sh esce con 0 (ottenuto $rc)" test "$rc" -eq 0
check "backup applicativo creato" test -n "$(find "$WORK/backups" -maxdepth 2 -name manifest.json | head -n 1)"
check "dump creato e non vuoto" test -n "$(find "$WORK/backups/dumps" -name 'soldi-*.sql.gz' -size +0 | head -n 1)"
check "ops-state/backup.json ok" grep -q '"ok":true' "$WORK/ops-state/backup.json"

leftovers() { docker ps -a --format '{{.Names}}' | grep -c 'soldi-restoretest' || true; }
net_leftovers() { docker network ls --format '{{.Name}}' | grep -c 'soldi-restoretest' || true; }

say "restore-test.sh (deve riuscire)"
rc=0; "$REPO/ops/restore-test.sh" --home "$WORK" || rc=$?
check "restore-test.sh esce con 0 (ottenuto $rc)" test "$rc" -eq 0
check "nessun container di prova rimasto" test "$(leftovers)" = 0
check "nessuna rete di prova rimasta" test "$(net_leftovers)" = 0
check "il database di produzione non è cambiato" test "$(sql 'SELECT count(*) FROM transactions')" = "$TX_BEFORE"

say "watch.sh sullo stack sano (prima di corrompere il backup)"
rc=0; "$REPO/ops/watch.sh" --home "$WORK" || rc=$?
check "watch.sh esce con 0 (ottenuto $rc)" test "$rc" -eq 0

say "restore-test.sh con CSV corrotto (deve FALLIRE)"
latest="$(find "$WORK/backups" -maxdepth 1 -type d -name 'soldi-backup-*' | sort | tail -n 1)"
head -n 3 "$latest/transactions.csv" > "$latest/transactions.csv.tmp" && mv "$latest/transactions.csv.tmp" "$latest/transactions.csv"
rc=0; "$REPO/ops/restore-test.sh" --home "$WORK" || rc=$?
check "restore-test.sh esce con 1 (ottenuto $rc)" test "$rc" -eq 1
check "stato restore-test.json = fallito" grep -q '"ok":false' "$WORK/ops-state/restore-test.json"
check "nessun container di prova rimasto" test "$(leftovers)" = 0
check "nessuna rete di prova rimasta" test "$(net_leftovers)" = 0
check "utenti di produzione intatti" test "$(sql 'SELECT count(*) FROM users')" = "$USERS_BEFORE"
check "movimenti di produzione intatti" test "$(sql 'SELECT count(*) FROM transactions')" = "$TX_BEFORE"

say "watch.sh segnala la prova di ripristino fallita"
rc=0; "$REPO/ops/watch.sh" --home "$WORK" || rc=$?
check "watch.sh esce con 1 (ottenuto $rc)" test "$rc" -eq 1

if [ "$FAILED" -ne 0 ]; then echo; echo "INTEGRAZIONE: FALLITA"; exit 1; fi
echo; echo "INTEGRAZIONE: OK"
