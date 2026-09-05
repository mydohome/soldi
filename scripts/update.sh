#!/usr/bin/env bash
#
# Soldi — aggiornamento in-place.
# Backup dei dati -> aggiorna il codice -> rebuild dei container -> verifica.
# Eseguire dalla cartella del progetto:  ./scripts/update.sh
#
# Funziona anche se la cartella è solo una copia dei file (non un clone git):
# in quel caso la aggancia a GitHub la prima volta.
#
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_URL="https://github.com/mydohome/soldi.git"

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "\n${c_info}▸ %s${c_off}\n" "$1"; }
ok()   { printf "${c_ok}✓ %s${c_off}\n" "$1"; }
warn() { printf "${c_err}  %s${c_off}\n" "$1"; }
die()  { printf "\n${c_err}✗ %s${c_off}\n" "$1" >&2; exit 1; }

# --- prerequisiti ------------------------------------------------------------
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

# --- git in sola lettura, anonimo e senza prompt ---------------------------
# Il repository è pubblico: si aggiorna senza credenziali. Neutralizziamo un
# eventuale credential helper o token scaduto lasciato da un clone precedente,
# e non lasciamo mai che git si fermi a chiedere utente/password.
git_ro() {
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true GIT_CONFIG_NOSYSTEM=1 \
    git -c credential.helper= \
        -c 'http.https://github.com/.extraheader=' \
        -c 'http.extraheader=' \
        "$@"
}

# --- 0. aggancia la cartella a git se non lo è già ------------------------
# Un deploy fatto scaricando lo ZIP (o copiando i file) non ha .git: senza,
# né questo script né "Impostazioni → Aggiorna" possono funzionare.
if [ ! -d .git ]; then
  log "Questa cartella non è un checkout git: la collego a GitHub…"
  git init -q
  git config --local credential.helper ""
  git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"
  if ! git_ro fetch --quiet origin main; then
    die "Impossibile scaricare il codice da GitHub ($REPO_URL). Controlla la connessione di rete."
  fi

  # I file locali sono una copia del repo; .env, backups/ e node_modules sono
  # gitignorati e NON vengono toccati. I file tracciati vengono riportati alla
  # versione ufficiale di GitHub.
  printf "\n"
  warn "I file di codice verranno riallineati alla versione di GitHub (main)."
  warn ".env, backups/ e i dati del database NON vengono toccati."
  if [ -t 0 ]; then
    printf "  Procedo? [s/N] "
    read -r reply
    case "$reply" in [sSyY]*) ;; *) die "Annullato." ;; esac
  fi
  git reset -q --hard origin/main
  git branch -q --set-upstream-to=origin/main main 2>/dev/null || true
  ok "Cartella collegata a GitHub — ora gli aggiornamenti sono automatici."
fi

# --- rimetti il remote su HTTPS anonimo (annulla SSH o token nell'URL) ----
origin_url="$(git remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  git@github.com:*)       clean="https://github.com/${origin_url#git@github.com:}" ;;
  ssh://git@github.com/*) clean="https://github.com/${origin_url#ssh://git@github.com/}" ;;
  https://*@github.com/*) clean="https://github.com/${origin_url#https://*@github.com/}" ;;
  *)                      clean="$origin_url" ;;
esac
if [ -n "$clean" ] && [ "$clean" != "$origin_url" ]; then
  git remote set-url origin "$clean"
  ok "Remote normalizzato: $clean"
fi

# --- 1. backup (solo se lo stack è in esecuzione) -------------------------
if $DC ps web 2>/dev/null | grep -qiE 'up|running|healthy'; then
  log "Backup dei dati prima dell'aggiornamento…"
  if $DC exec -T web npm run backup; then
    ok "Backup creato in ./backups"
  else
    warn "backup non riuscito — proseguo comunque"
  fi
else
  echo "Stack non in esecuzione: salto il backup."
fi

# --- 2. aggiorna il codice ----------------------------------------------
log "Scarico gli aggiornamenti…"
before="$(git rev-parse --short HEAD)"

if ! git_ro fetch --quiet origin main; then
  die "Impossibile contattare GitHub (git fetch fallito).
   Remote: $(git remote get-url origin)
   Prova a mano:  git -c credential.helper= fetch origin main
   Se il repo è pubblico dovrebbe funzionare senza credenziali."
fi

if ! git merge --ff-only origin/main; then
  die "Aggiornamento non fast-forward: ci sono commit o modifiche locali sul server.
   Controlla:  git status
   Per buttare via le modifiche locali:  git reset --hard origin/main   (ATTENZIONE: irreversibile)"
fi

after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then
  ok "Già all'ultima versione ($after). Ricostruisco comunque per sicurezza."
else
  echo "Aggiornato: $before → $after"
  git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

# --- 3. rebuild + restart ---------------------------------------------
log "Ricostruisco e riavvio i container…"
GIT_SHA="$(git rev-parse HEAD)" $DC up -d --build

# --- 4. attesa + verifica -------------------------------------------
port="$(grep -E '^HOST_PORT=' .env | head -1 | cut -d= -f2 | tr -d ' "')"
port="${port:-3000}"

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
