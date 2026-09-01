#!/usr/bin/env bash
#
# Soldi — aggiornamento in-place.
# Backup dei dati -> git pull -> rebuild dei container -> verifica.
# Eseguire dalla cartella del progetto:  ./scripts/update.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "\n${c_info}▸ %s${c_off}\n" "$1"; }
ok()   { printf "${c_ok}✓ %s${c_off}\n" "$1"; }
die()  { printf "\n${c_err}✗ %s${c_off}\n" "$1" >&2; exit 1; }

# --- prerequisiti ---------------------------------------------------------------
[ -f docker-compose.yml ] || die "docker-compose.yml non trovato. Esegui lo script dalla cartella del progetto."
[ -f .env ]               || die "File .env mancante: crealo da .env.example prima di aggiornare."
command -v git >/dev/null || die "git non installato."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Docker Compose non disponibile."
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Ci sono modifiche locali non committate ai file del repo. Annullale o committale, poi riprova."
fi

# --- 1. backup (solo se lo stack è in esecuzione) ------------------------------
if $DC ps --status running --services 2>/dev/null | grep -qx web; then
  log "Backup dei dati prima dell'aggiornamento…"
  if $DC exec -T web npm run backup; then
    ok "Backup creato in ./backups"
  else
    printf "${c_err}  backup non riuscito — proseguo comunque${c_off}\n"
  fi
else
  echo "Stack non in esecuzione: salto il backup."
fi

# --- 2. aggiorna il codice ----------------------------------------------------
log "Scarico gli aggiornamenti…"
before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)

if [ "$before" = "$after" ]; then
  ok "Già all'ultima versione ($after). Ricostruisco comunque per sicurezza."
else
  echo "Aggiornato: $before → $after"
  git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

# --- 3. rebuild + restart ----------------------------------------------------
log "Ricostruisco e riavvio i container…"
$DC up -d --build

# --- 4. attesa + verifica ---------------------------------------------------
port=$(grep -E '^HOST_PORT=' .env | head -1 | cut -d= -f2 | tr -d ' "' )
port=${port:-3000}

log "Attendo che l'app risponda su :$port…"
for _ in $(seq 1 40); do
  if curl -fsS "http://localhost:${port}/api/health" >/dev/null 2>&1; then
    ok "Soldi è aggiornato e risponde su http://localhost:${port}"
    $DC ps
    exit 0
  fi
  sleep 2
done

die "L'app non risponde dopo 80s. Controlla i log:  $DC logs web"
