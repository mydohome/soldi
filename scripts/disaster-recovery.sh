#!/usr/bin/env bash
#
# Soldi — ripristino completo da backup (disaster recovery).
#
# Da usare dopo una reinstallazione da zero: server perso, migrazione su
# un'altra macchina, o volume del database cancellato. Presuppone che tu
# abbia già fatto a mano la parte "distruttiva":
#
#   1. installato Docker e clonato il repository
#   2. creato .env (nuovo JWT_SECRET se non riusi quello vecchio)
#   3. copiato dentro ./backups le cartelle soldi-backup-* da recuperare
#   4. (se stai ripartendo sulla stessa macchina) fatto girare
#      `docker compose down -v` per eliminare eventuali dati corrotti
#
# Da qui in poi lo script crea lo schema, ripristina i dati e avvia l'app.
#
# Uso:
#   ./scripts/disaster-recovery.sh                  # backup più recente
#   ./scripts/disaster-recovery.sh --latest
#   ./scripts/disaster-recovery.sh soldi-backup-2026-01-05_03-00-00
#
set -euo pipefail

cd "$(dirname "$0")/.."

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "\n${c_info}▸ %s${c_off}\n" "$1"; }
ok()   { printf "${c_ok}✓ %s${c_off}\n" "$1"; }
warn() { printf "${c_err}  %s${c_off}\n" "$1"; }
die()  { printf "\n${c_err}✗ %s${c_off}\n" "$1" >&2; exit 1; }

# --- prerequisiti ------------------------------------------------------------
# COMPOSE_FILE (variabile standard di docker compose) permette di usare un file
# alternativo, es.  COMPOSE_FILE=docker-compose.npm.yml ./scripts/disaster-recovery.sh
if [ -z "${COMPOSE_FILE:-}" ] && [ ! -f docker-compose.yml ]; then
  die "docker-compose.yml non trovato. Esegui lo script dalla cartella del progetto,
   oppure imposta COMPOSE_FILE=<file> se usi un compose alternativo."
fi
[ -f .env ] || die "File .env mancante: crealo da .env.example prima di continuare."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Docker Compose non disponibile."
fi

[ -d backups ] && [ -n "$(ls -A backups 2>/dev/null)" ] ||
  die "Cartella ./backups vuota o assente.
   Copiaci dentro le cartelle soldi-backup-* prima di continuare."

# --- normalizza l'argomento (facoltativo) in un percorso dentro al container -
# npm run restore gira dentro al container web, quindi vuole "--latest" oppure
# un percorso assoluto sotto /app/backups (dove ./backups è montato).
arg="${1:---latest}"
if [ "$arg" = "--latest" ]; then
  restore_arg="--latest"
else
  restore_arg="/app/backups/$(basename "$arg")"
fi

warn "Questo crea/ricrea lo schema e SOSTITUISCE tutti i dati con quelli del backup scelto ($restore_arg)."
if [ -t 0 ]; then
  printf "  Procedo? [s/N] "
  read -r reply
  case "$reply" in [sSyY]*) ;; *) die "Annullato." ;; esac
fi

# --- 1. avvia solo il database e attendi che sia pronto ---------------------
log "Avvio il database…"
$DC up -d db

log "Attendo che il database sia pronto…"
for _ in $(seq 1 30); do
  if $DC exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    ok "Database pronto."
    break
  fi
  sleep 2
done
$DC exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 ||
  die "Il database non risponde. Controlla i log:  $DC logs db"

# --- 2. crea lo schema --------------------------------------------------
log "Creo lo schema…"
$DC run --rm web npm run migrate

# --- 3. ripristina i dati dal backup -------------------------------------
log "Ripristino i dati da backup ($restore_arg)…"
$DC run --rm web npm run restore -- "$restore_arg" --yes

# --- 4. avvia l'app e verifica -------------------------------------------
log "Avvio l'app…"
$DC up -d web

health_check='fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
log "Attendo che l'app risponda…"
for _ in $(seq 1 40); do
  if $DC exec -T web node -e "$health_check" >/dev/null 2>&1; then
    ok "Soldi è di nuovo online."
    $DC exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
      SELECT (SELECT count(*) FROM users)            AS utenti,
             (SELECT count(*) FROM categories)       AS categorie,
             (SELECT count(*) FROM accounts)         AS conti,
             (SELECT count(*) FROM recurring_rules)  AS spese_fisse,
             (SELECT count(*) FROM transactions)     AS movimenti;"' \
      || warn "App online, ma non sono riuscito a leggere il riepilogo dal database."
    $DC ps
    exit 0
  fi
  sleep 2
done

die "L'app non risponde dopo 80s. Controlla i log:  $DC logs web"
