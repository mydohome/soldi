#!/usr/bin/env bash
#
# Soldi — apre il menu interattivo di gestione utenti (crea/scegli un utente,
# cambia password, configura/rimuovi Telegram) dentro al container in
# esecuzione. Scorciatoia per:  docker compose exec web npm run user:manage
#
# Va eseguito dalla cartella dove sta docker-compose.yml (non dalla cartella
# dello script stesso: se il checkout git vive in una sottocartella separata
# — es. ~/docker/soldi/ con dentro docker-compose.yml/.env e ~/docker/soldi/app/
# col codice — vai in ~/docker/soldi/ e lancia ./app/scripts/manage-users.sh),
# in un terminale vero (serve un TTY, non funziona in uno script non interattivo):
#   ./scripts/manage-users.sh
#
# Con docker-compose.npm.yml:
#   COMPOSE_FILE=docker-compose.npm.yml ./scripts/manage-users.sh
#
set -euo pipefail

c_err='\033[1;31m'; c_off='\033[0m'
die() { printf "\n${c_err}✗ %s${c_off}\n" "$1" >&2; exit 1; }

# COMPOSE_FILE (variabile standard di docker compose) permette di usare un file
# alternativo, es.  COMPOSE_FILE=docker-compose.npm.yml ./scripts/manage-users.sh
if [ -z "${COMPOSE_FILE:-}" ] && [ ! -f docker-compose.yml ]; then
  die "docker-compose.yml non trovato nella cartella corrente ($(pwd)).
   Vai nella cartella dove sta docker-compose.yml (non necessariamente quella
   dello script) prima di lanciarlo, oppure imposta COMPOSE_FILE=<file> se usi
   un compose alternativo (es. docker-compose.npm.yml)."
fi
[ -f .env ] || die "File .env mancante: crealo da .env.example prima di continuare."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Docker Compose non disponibile."
fi

$DC ps web 2>/dev/null | grep -qiE 'up|running|healthy' ||
  die "Il container 'web' non risulta in esecuzione. Avvialo con:  $DC up -d"

exec $DC exec web npm run user:manage
