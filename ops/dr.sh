#!/usr/bin/env bash
# dr.sh — ripristino di emergenza guidato: ricostruisce Soldi su una macchina nuova (o
# dopo aver perso tutto) a partire da una cartella di backup o da un repository restic.
#
#   1. verifica i prerequisiti (docker, compose v2, git, restic se la fonte è remota)
#   2. fonte dei dati: --source-dir <cartella con backups/ e .env> oppure --restic
#      (ultimo snapshot o --snapshot <id>; contiene anche il .env originale)
#   3. clona il repository in app/ se manca; ripristina il .env originale (o, con
#      --ask-secrets, chiede JWT_SECRET e SECRETS_KEY originali)
#   4. crea la rete proxy-net se serve, avvia SOLO il database e attende che sia sano
#   5. migrate + restore.js in un container usa-e-getta, poi avvia web, attende lo stato
#      sano e lancia la diagnostica
#
# Richiede di digitare RIPRISTINA prima di toccare i dati. --dry-run stampa i passaggi
# senza eseguirli.
#
# Uso: dr.sh [--home <cartella>] (--source-dir <dir> | --restic [--snapshot <id>])
#            [--backup <nome>] [--repo-url <url>] [--ask-secrets] [--dry-run]
#            [--restic-repo <repo> --restic-password-file <file>]
# Senza --home usa la cartella corrente come cartella di deploy (docker-compose.yml, .env,
# backups/ e app/ = checkout git). Uscita: 0 ok, 1 errore.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

HOME_ARG=""; SRC_DIR=""; USE_RESTIC=0; SNAPSHOT=latest; BACKUP_ARG=""; DRY=0; ASK_SECRETS=0
REPO_URL="${REPO_URL:-https://github.com/mydohome/soldi.git}"
while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --source-dir) SRC_DIR="${2:-}"; shift 2 ;;
    --restic) USE_RESTIC=1; shift ;;
    --snapshot) SNAPSHOT="${2:-latest}"; shift 2 ;;
    --restic-repo) export RESTIC_REPOSITORY="${2:-}"; shift 2 ;;
    --restic-password-file) export RESTIC_PASSWORD_FILE="${2:-}"; shift 2 ;;
    --backup) BACKUP_ARG="${2:-}"; shift 2 ;;
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --ask-secrets) ASK_SECRETS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
[ -n "$SRC_DIR" ] || [ "$USE_RESTIC" = 1 ] || die "Indica la fonte dei dati: --source-dir <cartella> oppure --restic."

# Cartella di deploy: --home, altrimenti la cartella corrente. Può essere ancora vuota.
COMPOSE_DIR="${HOME_ARG:-$PWD}"
if [ "$DRY" = 1 ]; then OPS_DRY_RUN=1; export OPS_DRY_RUN; fi
if [ "$DRY" = 0 ]; then mkdir -p "$COMPOSE_DIR"; fi
[ -d "$COMPOSE_DIR" ] || COMPOSE_DIR="$(cd "$(dirname "$COMPOSE_DIR")" && pwd)/$(basename "$COMPOSE_DIR")"
[ ! -d "$COMPOSE_DIR" ] || COMPOSE_DIR="$(cd "$COMPOSE_DIR" && pwd)"
if [ -d "$COMPOSE_DIR" ]; then apply_layout; else
  LAYOUT=deploy; APP_DIR="$COMPOSE_DIR/app"; BACKUPS_DIR="$COMPOSE_DIR/backups"
  STATE_DIR="$COMPOSE_DIR/ops-state"; OPS_ENV_FILE="${OPS_ENV:-$COMPOSE_DIR/ops.env}"
fi
RESTIC="${RESTIC:-restic}"

plan() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*" >&2; return 0; fi; log "$*"; return 1; }

# --- 1. prerequisiti ---------------------------------------------------------------------------
DOCKER="${DOCKER:-docker}"
missing=""
command -v "$DOCKER" >/dev/null 2>&1 || missing="docker"
command -v git >/dev/null 2>&1 || missing="${missing:+$missing, }git"
if [ "$USE_RESTIC" = 1 ] && ! command -v "$RESTIC" >/dev/null 2>&1; then missing="${missing:+$missing, }restic"; fi
if [ -z "${DC:-}" ] && [ -z "$missing" ]; then
  if "$DOCKER" compose version >/dev/null 2>&1; then DC="$DOCKER compose"
  elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
  else missing="docker compose (v2)"; fi
fi
if [ -n "$missing" ]; then
  if [ "$DRY" = 1 ]; then warn "Prerequisiti mancanti (in dry-run solo un avviso): $missing"; DC="${DC:-docker compose}"
  else die "Prerequisiti mancanti: $missing."; fi
fi

if [ "$DRY" = 0 ]; then
  job_begin dr
  lock_acquire update   # lo stesso lock di aggiornamento e ripristino
fi

# --- 2. fonte dei dati ---------------------------------------------------------------------------
SRC_BACKUPS=""; SRC_ENV=""; SRC_COMPOSE=""; RT_TMP=""
ops_cleanup() { [ -z "$RT_TMP" ] || rm -rf "$RT_TMP"; }

if [ "$USE_RESTIC" = 1 ]; then
  if plan "restic restore $SNAPSHOT --tag soldi → cartella temporanea (backups/, .env e docker-compose.yml originali)"; then :; else
    [ -n "${RESTIC_REPOSITORY:-}" ] || RESTIC_REPOSITORY="$(opsval RESTIC_REPOSITORY)"
    [ -n "${RESTIC_PASSWORD_FILE:-}" ] || RESTIC_PASSWORD_FILE="$(opsval RESTIC_PASSWORD_FILE)"
    [ -n "$RESTIC_REPOSITORY" ] && [ -n "$RESTIC_PASSWORD_FILE" ] || die "Per --restic servono RESTIC_REPOSITORY e RESTIC_PASSWORD_FILE (in ops.env, nell'ambiente o con --restic-repo/--restic-password-file)."
    export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
    export_ops_prefix AWS_ B2_ AZURE_ GOOGLE_ OS_ ST_
    RT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/soldi-dr.XXXXXX")"
    if [ "$SNAPSHOT" = latest ]; then "$RESTIC" restore latest --tag soldi --target "$RT_TMP" >&2 || die "restic restore non riuscito."
    else "$RESTIC" restore "$SNAPSHOT" --target "$RT_TMP" >&2 || die "restic restore non riuscito."; fi
    SRC_BACKUPS="$(find_backups_root "$RT_TMP")"
    SRC_ENV="$(find "$RT_TMP" -name .env -type f 2>/dev/null | head -n 1)" || true
    SRC_COMPOSE="$(find "$RT_TMP" -name docker-compose.yml -type f -not -path '*/app/*' 2>/dev/null | head -n 1)" || true
    [ -n "$SRC_BACKUPS" ] || die "Lo snapshot non contiene backup applicativi (soldi-backup-*)."
  fi
elif [ "$DRY" = 0 ]; then
  [ -d "$SRC_DIR" ] || die "Cartella sorgente non trovata: $SRC_DIR"
  SRC_DIR="$(cd "$SRC_DIR" && pwd)"
  if [ -n "$(find "$SRC_DIR/backups" -maxdepth 1 -name 'soldi-backup-*' 2>/dev/null | head -n 1)" ]; then
    SRC_BACKUPS="$SRC_DIR/backups"; SRC_ENV="$SRC_DIR/.env"
  elif [ -n "$(find "$SRC_DIR" -maxdepth 1 -name 'soldi-backup-*' 2>/dev/null | head -n 1)" ]; then
    SRC_BACKUPS="$SRC_DIR"; SRC_ENV="$SRC_DIR/.env"; [ -f "$SRC_ENV" ] || SRC_ENV="$(dirname "$SRC_DIR")/.env"
  else die "In $SRC_DIR non ci sono backup applicativi (soldi-backup-*)."; fi
  [ -f "$SRC_DIR/docker-compose.yml" ] && SRC_COMPOSE="$SRC_DIR/docker-compose.yml"
else
  plan "fonte: cartella $SRC_DIR (backups/ e .env)"
fi

# --- riepilogo e conferma ------------------------------------------------------------------------
{
  printf '\nRipristino di emergenza in: %s\n  repository: %s → %s\n  fonte: %s\n' "$COMPOSE_DIR" "$REPO_URL" "$APP_DIR" "${SRC_DIR:-restic ($SNAPSHOT)}"
  printf '  Verranno creati/sostituiti: .env, docker-compose.yml (se manca), backups/, il database db.\n'
} >&2
if [ "$DRY" = 0 ]; then
  confirm_typed RIPRISTINA "Questo SOSTITUISCE i dati del database con quelli del backup." || die "Annullato: nessuna modifica."
fi

# --- 3. repository, .env, compose, backups ---------------------------------------------------------
if plan "git clone $REPO_URL $APP_DIR (se manca)"; then :; elif [ ! -d "$APP_DIR/.git" ]; then
  [ "$LAYOUT" = deploy ] || APP_DIR="$COMPOSE_DIR/app"
  git clone --quiet "$REPO_URL" "$APP_DIR" >&2 || die "git clone non riuscito ($REPO_URL)."
  LAYOUT=deploy
  ok "Repository clonato in $APP_DIR"
fi

if plan "ripristino del .env originale dalla fonte (copia di sicurezza di quello esistente, permessi 600)"; then :; else
  src_key=""
  if [ -n "$SRC_ENV" ] && [ -f "$SRC_ENV" ]; then
    src_key="$(read_kv "$SRC_ENV" SECRETS_KEY)"
    if [ -f "$COMPOSE_DIR/.env" ] && ! cmp -s "$SRC_ENV" "$COMPOSE_DIR/.env"; then
      cur_key="$(read_kv "$COMPOSE_DIR/.env" SECRETS_KEY)"
      [ -z "$cur_key" ] || [ "$cur_key" = "$src_key" ] || warn "Il .env esistente aveva una SECRETS_KEY diversa: vince quella originale del backup."
      cp -p "$COMPOSE_DIR/.env" "$COMPOSE_DIR/.env.pre-dr-$(date +%Y%m%d-%H%M%S)"
    fi
    cp "$SRC_ENV" "$COMPOSE_DIR/.env"
  elif [ "$ASK_SECRETS" = 1 ]; then
    warn "Nessun .env nella fonte: inserisci i valori ORIGINALI. Con una SECRETS_KEY diversa le impostazioni Telegram cifrate nel database diventano illeggibili."
    printf 'JWT_SECRET originale: ' >&2; IFS= read -r jwt
    printf 'SECRETS_KEY originale (64 caratteri esadecimali): ' >&2; IFS= read -r key
    case "$key" in *[!0-9a-fA-F]*|'') die "SECRETS_KEY non valida: servono 64 caratteri esadecimali (openssl rand -hex 32)." ;; esac
    [ "${#key}" -eq 64 ] || die "SECRETS_KEY non valida: servono 64 caratteri esadecimali."
    [ -n "$jwt" ] || die "JWT_SECRET vuoto."
    if [ -f "$APP_DIR/.env.example" ]; then cp "$APP_DIR/.env.example" "$COMPOSE_DIR/.env"; else : > "$COMPOSE_DIR/.env"; fi
    set_kv "$COMPOSE_DIR/.env" JWT_SECRET "$jwt"
    set_kv "$COMPOSE_DIR/.env" SECRETS_KEY "$key"
    set_kv "$COMPOSE_DIR/.env" PGPASSWORD "$(rand_hex 16)"
    src_key="$key"
  else
    die "La fonte non contiene il .env originale. Servono JWT_SECRET e SECRETS_KEY originali: rilancia con --ask-secrets per inserirli (senza SECRETS_KEY le impostazioni Telegram cifrate non si leggono più)."
  fi
  chmod 600 "$COMPOSE_DIR/.env"
  [ -n "$src_key" ] || warn "Il .env non contiene SECRETS_KEY: le credenziali Telegram salvate non saranno leggibili."
fi

if plan "docker-compose.yml: dalla fonte, altrimenti quello del repository (se manca)"; then :; elif [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  if [ -n "$SRC_COMPOSE" ] && [ -f "$SRC_COMPOSE" ]; then cp "$SRC_COMPOSE" "$COMPOSE_DIR/docker-compose.yml"; ok "docker-compose.yml ripristinato dalla fonte."
  elif [ -f "$APP_DIR/docker-compose.yml" ]; then cp "$APP_DIR/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yml"; warn "Uso il docker-compose.yml del repository: se in produzione ne usavi uno diverso (es. 'hardened'), sostituiscilo prima di esporre il servizio."
  else die "Nessun docker-compose.yml trovato."; fi
fi

if plan "copia dei backup in $BACKUPS_DIR"; then :; else
  mkdir -p "$BACKUPS_DIR"
  if [ "$(cd "$SRC_BACKUPS" && pwd -P)" != "$(cd "$BACKUPS_DIR" && pwd -P)" ]; then
    cp -R "$SRC_BACKUPS"/. "$BACKUPS_DIR"/
  fi
  chmod -R go-rwx "$BACKUPS_DIR" 2>/dev/null || true
fi

if [ "$DRY" = 1 ]; then BACKUP_NAME="${BACKUP_ARG:-<ultimo backup>}"; else
  if [ -n "$BACKUP_ARG" ]; then BACKUP_NAME="$(basename "$BACKUP_ARG")"; else BACKUP_NAME="$(basename "$(latest_app_backup)")"; fi
  [ -f "$BACKUPS_DIR/$BACKUP_NAME/manifest.json" ] || die "Backup non valido o mancante: $BACKUP_NAME"
fi

# --- 4. rete e database --------------------------------------------------------------------------
if plan "docker network create proxy-net (se il compose la usa e non esiste)"; then :; elif grep -q 'proxy-net' "$COMPOSE_DIR/docker-compose.yml" 2>/dev/null && ! "$DOCKER" network inspect proxy-net >/dev/null 2>&1; then
  "$DOCKER" network create proxy-net >&2
fi
if plan "$DC up -d db  (solo il database) e attesa dello stato sano"; then :; else
  $DC up -d db >&2 || die "Impossibile avviare il database."
  ready=0
  for ((i = 0; i < ${DB_TRIES:-60}; i++)); do
    if $DC exec -T db pg_isready -U "$(PGUSER_ENV)" -d "$(PGDATABASE_ENV)" >/dev/null 2>&1; then ready=1; break; fi
    sleep "${DB_SLEEP:-2}"
  done
  [ "$ready" = 1 ] || die "Il database non è diventato pronto."
fi

# --- 5. ripristino e avvio ------------------------------------------------------------------------
if plan "$DC run --rm --no-deps -T web node src/db/migrate.js  poi  node src/backup/restore.js /app/backups/$BACKUP_NAME --yes  (container usa-e-getta)"; then :; else
  restore_in_container "$BACKUP_NAME" --migrate \
    || die "Ripristino NON riuscito: il database è vuoto o inalterato. Controlla il messaggio sopra; web non è stato avviato."
fi
if plan "$DC up -d --build web, attesa dello stato sano, diagnostica (npm run diag)"; then :; else
  $DC up -d --build web >&2 || die "Impossibile avviare web."
  wait_healthy || die "web non è diventato sano: controlla i log (docker compose logs web)."
  rc=0; run_diag || rc=$?
  case "$rc" in
    0) ok "Diagnostica ok." ;;
    3) warn "Diagnostica non disponibile nell'immagine." ;;
    2) warn "Diagnostica con avvisi: leggili sopra." ;;
    *) die "La diagnostica ha trovato ERRORI nei dati ripristinati (vedi sopra)." ;;
  esac
fi

if [ "$DRY" = 1 ]; then
  ok "Dry-run completato: nessuna modifica eseguita."
  exit 0
fi
warn "Da fare ora: ricrea ops.env (notifiche, restic) e lancia  soldi cron install ; poi esegui una prova:  soldi backup  e  soldi restore-test"
job_finish ok "Ripristino di emergenza completato da $BACKUP_NAME. Verifica l'app e ricrea ops.env e il crontab." "$(printf '{"backup":%s}' "$(json_str "$BACKUP_NAME")")"
