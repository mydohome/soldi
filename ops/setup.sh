#!/usr/bin/env bash
# setup.sh — installazione guidata di Soldi.
#
#   1. controlla docker, compose v2, git, curl, openssl
#   2. chiede lo scenario di installazione (quelli descritti nel README)
#   3. genera il .env dal modello .env.example con segreti casuali (JWT_SECRET, SECRETS_KEY,
#      PGPASSWORD), ALLOW_REGISTRATION=false, permessi 600
#   4. crea la rete proxy-net se serve, avvia lo stack e attende che sia sano
#   5. propone di creare il primo utente e, facoltativamente, di configurare ops.env
#      (notifiche Telegram e copia fuori macchina)
#
# Sicurezza: non sovrascrive mai un .env esistente senza copia di sicurezza e conferma; i
# segreti già presenti si MANTENGONO (cambiare SECRETS_KEY rende illeggibili le credenziali
# Telegram, cambiare JWT_SECRET chiude le sessioni); rifiuta di rigenerare PGPASSWORD se il
# volume db-data esiste già (POSTGRES_PASSWORD vale solo alla prima inizializzazione:
# cambiarla romperebbe l'accesso al database).
#
# Per l'automazione: SETUP_STDIN=1 legge le risposte da stdin anche senza terminale.
#
# Uso: setup.sh [--home <cartella>] [--scenario 1|2|3|4] [--tz <fuso>] [--yes]
#                [--no-start] [--skip-user] [--ops-env]
#   scenari: 1 = in LAN/locale (HTTP) · 2 = dietro proxy sullo stesso host (porta solo locale)
#            3 = dietro proxy su rete Docker (docker-compose.npm.yml) · 4 = proxy su un altro host
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

HOME_ARG=""; SCENARIO=""; TZ_ARG=""; YES=0; NO_START=0; SKIP_USER=0; DO_OPS_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --scenario) SCENARIO="${2:-}"; shift 2 ;;
    --tz) TZ_ARG="${2:-}"; shift 2 ;;
    --yes) YES=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --skip-user) SKIP_USER=1; shift ;;
    --ops-env) DO_OPS_ENV=1; shift ;;
    -h|--help) sed -n '2,24p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done

# --- cartella del progetto: può non avere ancora il .env --------------------------------------
if [ -n "$HOME_ARG" ]; then COMPOSE_DIR="$(cd "$HOME_ARG" && pwd)"
elif [ -n "${SOLDI_HOME:-}" ] && [ -d "$SOLDI_HOME" ]; then COMPOSE_DIR="$(cd "$SOLDI_HOME" && pwd)"
elif [ -f "$PWD/docker-compose.yml" ]; then COMPOSE_DIR="$PWD"
else COMPOSE_DIR="$(cd "$OPS_DIR/.." && pwd)"; fi
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "In $COMPOSE_DIR non c'è docker-compose.yml: lancia lo script dalla cartella del progetto (o con --home)."
apply_layout
[ -f "$APP_DIR/.env.example" ] || die "Manca $APP_DIR/.env.example: il repository è completo?"

# Risposte: dal terminale; con --yes o senza terminale vale il valore predefinito. Per
# l'automazione, SETUP_STDIN=1 legge le risposte da stdin anche senza terminale.
interactive() { [ "$YES" != 1 ] && { [ -t 0 ] || [ -n "${SETUP_STDIN:-}" ]; }; }
ask() { # prompt default → risposta
  local prompt="$1" def="${2:-}" reply=""
  if ! interactive; then printf '%s' "$def"; return 0; fi
  printf '%s [%s] ' "$prompt" "$def" >&2
  IFS= read -r reply || reply=""
  printf '%s' "${reply:-$def}"
}
yesno() { # prompt default(s|n) → 0 se sì
  local a; a="$(ask "$1" "$2")"
  case "$a" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

# --- 1. prerequisiti ----------------------------------------------------------------------------
DOCKER="${DOCKER:-docker}"
missing=""
command -v "$DOCKER" >/dev/null 2>&1 || missing="docker"
for c in git curl openssl; do command -v "$c" >/dev/null 2>&1 || missing="${missing:+$missing, }$c"; done
if [ -z "${DC:-}" ] && command -v "$DOCKER" >/dev/null 2>&1; then
  if "$DOCKER" compose version >/dev/null 2>&1; then DC="$DOCKER compose"
  else missing="${missing:+$missing, }docker compose v2"; fi
fi
[ -z "$missing" ] || die "Prerequisiti mancanti: $missing. Installali e rilancia."
DC="${DC:-$DOCKER compose}"
ok "Prerequisiti ok (docker, compose v2, git, curl, openssl)."

# --- 2. scenario ----------------------------------------------------------------------------------
if [ -z "$SCENARIO" ]; then
  cat >&2 <<'TXT'

Scenario di installazione (vedi README):
  1) In LAN o in locale, senza reverse proxy (HTTP)      → docker-compose.yml
  2) Dietro un proxy sullo STESSO host, porta solo locale → docker-compose.yml (A)
  3) Dietro un proxy sullo stesso host, su rete Docker     → docker-compose.npm.yml (B), nessuna porta pubblicata
  4) Dietro un proxy su UN ALTRO host della rete           → docker-compose.yml (C)
TXT
  SCENARIO="$(ask 'Scegli 1-4' 1)"
fi
COMPOSE_FILE_NAME="docker-compose.yml"; BIND=0.0.0.0; PORT=3000; HTTPS=false; TRUSTP=0
case "$SCENARIO" in
  1) PORT=3000 ;;
  2) BIND=127.0.0.1; PORT=3010; HTTPS=true; TRUSTP=1 ;;
  3) COMPOSE_FILE_NAME="docker-compose.npm.yml"; HTTPS=true; TRUSTP=1 ;;
  4) BIND=0.0.0.0; PORT=3010; HTTPS=true; TRUSTP=1 ;;
  *) die "Scenario non valido: $SCENARIO (1-4)." ;;
esac
[ -f "$COMPOSE_DIR/$COMPOSE_FILE_NAME" ] || die "Manca $COMPOSE_FILE_NAME in $COMPOSE_DIR."
log "Scenario $SCENARIO → $COMPOSE_FILE_NAME"
TZVAL="${TZ_ARG:-$(ask 'Fuso orario' "$(read_kv "$APP_DIR/.env.example" TZ)")}"

# --- 3. .env -----------------------------------------------------------------------------------
ENVF="$COMPOSE_DIR/.env"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$COMPOSE_DIR" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-\n' '_')}"
db_volume_exists() {
  [ -n "$("$DOCKER" volume ls -q --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.volume=db-data' 2>/dev/null)" ]
}
placeholder() { case "$1" in ''|change-me*|soldi) return 0 ;; *) return 1 ;; esac; }

old_jwt=""; old_key=""; old_pw=""
if [ -f "$ENVF" ]; then
  warn "Esiste già un .env in $COMPOSE_DIR."
  yesno "Lo riscrivo dal modello (ne faccio prima una copia di sicurezza; i segreti già presenti restano)?" n || die "Annullato: il .env non è stato toccato."
  old_jwt="$(read_kv "$ENVF" JWT_SECRET)"; old_key="$(read_kv "$ENVF" SECRETS_KEY)"; old_pw="$(read_kv "$ENVF" PGPASSWORD)"
  bak="$ENVF.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENVF" "$bak"; chmod 600 "$bak"
  ok "Copia di sicurezza: $(basename "$bak")"
fi

jwt="$old_jwt";  placeholder "$jwt" && jwt="$(openssl rand -hex 32)"
key="$old_key"
case "$key" in *[!0-9a-fA-F]*|'') key="" ;; esac
[ "${#key}" -eq 64 ] || key="$(openssl rand -hex 32)"
if db_volume_exists; then
  # il database è già inizializzato con una password: va mantenuta
  if [ -z "$old_pw" ]; then
    warn "Il volume db-data esiste già ma non c'è un .env con la sua password: POSTGRES_PASSWORD vale solo alla prima inizializzazione, una nuova password romperebbe l'accesso al database."
    interactive || die "Rifiuto di generare una nuova PGPASSWORD con il volume db-data esistente. Inserisci quella originale (rilancia da terminale)."
    printf 'PGPASSWORD ORIGINALE del database: ' >&2; IFS= read -rs pw || pw=""; echo >&2
    [ -n "$pw" ] || die "PGPASSWORD vuota: annullato."
    old_pw="$pw"
  fi
  pgpw="$old_pw"; ok "Volume db-data esistente: PGPASSWORD mantenuta."
else
  pgpw="$old_pw"; placeholder "$pgpw" && pgpw="$(openssl rand -hex 16)"
fi

tmp="$ENVF.new.$$"
cp "$APP_DIR/.env.example" "$tmp"
set_kv "$tmp" JWT_SECRET "$jwt"
set_kv "$tmp" SECRETS_KEY "$key"
set_kv "$tmp" PGPASSWORD "$pgpw"
set_kv "$tmp" HTTPS_ENABLED "$HTTPS"
set_kv "$tmp" COOKIE_SECURE "$HTTPS"
set_kv "$tmp" TRUST_PROXY "$TRUSTP"
set_kv "$tmp" ALLOW_REGISTRATION false
set_kv "$tmp" TZ "$TZVAL"
set_kv "$tmp" BIND_ADDR "$BIND"
set_kv "$tmp" HOST_PORT "$PORT"
if [ "$COMPOSE_FILE_NAME" != docker-compose.yml ]; then
  set_kv "$tmp" COMPOSE_FILE "$COMPOSE_FILE_NAME"   # così compose e tutti gli script usano il file giusto
  # il compose npm esegue il container come ${PUID}:${PGID} (serve per l'aggiornamento dall'app)
  set_kv "$tmp" PUID "$(id -u)"
  set_kv "$tmp" PGID "$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
  [ -n "$(read_kv "$tmp" PGID)" ] || set_kv "$tmp" PGID "$(id -g)"
fi
chmod 600 "$tmp"; mv -f "$tmp" "$ENVF"
ok ".env scritto (permessi 600, ALLOW_REGISTRATION=false: il primo utente si crea da riga di comando)."

# --- 4. rete, avvio, attesa ---------------------------------------------------------------------
if [ "$NO_START" = 1 ]; then
  log "--no-start: stack non avviato."
else
  if grep -q 'proxy-net' "$COMPOSE_DIR/$COMPOSE_FILE_NAME" && ! "$DOCKER" network inspect proxy-net >/dev/null 2>&1; then
    log "Creo la rete proxy-net (la rete del reverse proxy: se NPM usa un altro nome, adegua docker-compose.npm.yml)."
    "$DOCKER" network create proxy-net >&2
  fi
  log "Avvio lo stack ($COMPOSE_FILE_NAME)…"
  export COMPOSE_FILE="$COMPOSE_FILE_NAME"
  $DC up -d --build >&2 || die "docker compose up non è riuscito."
  log "Attendo che l'app sia sana…"
  wait_healthy || die "L'app non è diventata sana: controlla i log (docker compose logs web)."
  ok "Soldi è in esecuzione."

  # --- 5. primo utente ----------------------------------------------------------------------------
  if [ "$SKIP_USER" = 0 ]; then
    if interactive && yesno "Creare ora il primo utente?" s; then
      $DC exec web npm run user:create || warn "Creazione utente non riuscita: riprova con  $DC exec web npm run user:create"
    else
      log "Per creare il primo utente: $DC exec web npm run user:create"
    fi
  fi
fi

# --- facoltativo: ops.env ---------------------------------------------------------------------------
if [ "$DO_OPS_ENV" = 1 ] || { [ ! -f "$OPS_ENV_FILE" ] && interactive && yesno "Configurare ora notifiche Telegram e copia fuori macchina (ops.env)?" n; }; then
  if [ -f "$OPS_ENV_FILE" ]; then
    warn "ops.env esiste già: non lo tocco."
  else
    cp "$APP_DIR/ops.env.example" "$OPS_ENV_FILE"; chmod 600 "$OPS_ENV_FILE"
    printf 'Token del bot Telegram di GESTIONE (invio per saltare): ' >&2; IFS= read -rs tok || tok=""; echo >&2
    if [ -n "$tok" ]; then
      printf 'Chat id: ' >&2; IFS= read -r chat || chat=""
      set_kv "$OPS_ENV_FILE" ALERT_TG_TOKEN "$tok"; set_kv "$OPS_ENV_FILE" ALERT_TG_CHAT "$chat"
    fi
    printf 'RESTIC_REPOSITORY (es. sftp:utente@host:/srv/backup/soldi; invio per saltare): ' >&2; IFS= read -r repo || repo=""
    if [ -n "$repo" ]; then
      pwf="$HOME/.restic-soldi-password"
      if [ ! -f "$pwf" ]; then
        openssl rand -base64 24 > "$pwf"; chmod 600 "$pwf"
        warn "Creata la password di restic in $pwf: CONSERVALA anche altrove (password manager): senza non si recupera nulla."
      fi
      set_kv "$OPS_ENV_FILE" RESTIC_REPOSITORY "$repo"; set_kv "$OPS_ENV_FILE" RESTIC_PASSWORD_FILE "$pwf"
      log "Crea il repository con:  soldi offsite --init"
    fi
    ok "ops.env creato (permessi 600)."
  fi
fi

cat >&2 <<TXT

Fatto. Prossimi passi consigliati:
  soldi cron install      # pianifica backup, controlli e sorveglianza
  soldi backup            # primo backup (applicativo + dump)
  soldi notify-test       # prova delle notifiche, se le hai configurate
  soldi restore-test      # prova di ripristino
Documentazione: docs/OPERATIONS.md
TXT
