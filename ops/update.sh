#!/usr/bin/env bash
# update.sh — aggiornamento di Soldi con backup obbligatorio e rollback automatico.
#
#   1. rifiuta se ci sono modifiche locali non committate o un altro aggiornamento in corso
#   2. backup: applicativo + dump PostgreSQL completo (obbligatorio, salvo --force)
#   3. git (solo fast-forward) → ricostruzione → attesa dello stato sano
#   4. se il container non diventa sano: torna al commit precedente e rifà il deploy
#
# Uso: update.sh [--force] [--yes] [--home <cartella>]
#   --force  procede anche se il backup fallisce
#   --yes    non chiede conferma (solo per agganciare a git una cartella che non è un clone)
# Uscita: 0 aggiornato e in salute; 1 in tutti gli altri casi — anche dopo un rollback
# riuscito: un aggiornamento fallito deve risultare fallito.
#
# Limiti: il rollback ripristina il CODICE, non il database. Lo schema cresce con
# modifiche additive, quindi il codice vecchio gira sul database nuovo; il dump
# pre-aggiornamento (backups/dumps/pre-update-*.sql.gz) copre i casi distruttivi.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

FORCE=0; ASSUME_YES=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose
REPO_URL="${REPO_URL:-https://github.com/mydohome/soldi.git}"
JOB_NOTIFY_OK=1
job_begin update
lock_acquire update

# git in sola lettura, anonimo e senza prompt: il repository è pubblico, si aggiorna
# senza credenziali (un credential helper o un token scaduto lasciato da un clone
# precedente non deve bloccare l'aggiornamento).
git_ro() {
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true GIT_CONFIG_NOSYSTEM=1 \
    git -c credential.helper= -c 'http.https://github.com/.extraheader=' -c http.extraheader= "$@"
}
app_git() { git_ro -C "$APP_DIR" "$@"; }

# --- 0. cartella non collegata a git (deploy fatto con uno ZIP) ----------------------
if [ ! -d "$APP_DIR/.git" ]; then
  warn "Questa cartella non è un checkout git: la collego a GitHub ($REPO_URL)."
  warn "I file di codice vengono riportati alla versione di GitHub (main). .env, backups/ e il database NON si toccano."
  if [ "$ASSUME_YES" != 1 ]; then
    [ -t 0 ] || die "Cartella non collegata a git: rilancia con --yes per confermare."
    printf '  Procedo? [s/N] ' >&2; read -r reply
    case "$reply" in [sSyY]*) ;; *) die "Annullato." ;; esac
  fi
  git_ro -C "$APP_DIR" init -q
  git_ro -C "$APP_DIR" remote add origin "$REPO_URL" 2>/dev/null || git_ro -C "$APP_DIR" remote set-url origin "$REPO_URL"
  app_git fetch --quiet origin main || die "Impossibile scaricare il codice da $REPO_URL."
  app_git reset -q --hard origin/main
  app_git branch -q --set-upstream-to=origin/main main 2>/dev/null || true
  ok "Cartella collegata a GitHub."
fi

# remote riportato su HTTPS anonimo (annulla SSH o token nell'URL)
origin_url="$(app_git remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  git@github.com:*)       clean="https://github.com/${origin_url#git@github.com:}" ;;
  ssh://git@github.com/*) clean="https://github.com/${origin_url#ssh://git@github.com/}" ;;
  https://*@github.com/*) clean="https://github.com/${origin_url#https://*@github.com/}" ;;
  *)                      clean="$origin_url" ;;
esac
if [ -n "$clean" ] && [ "$clean" != "$origin_url" ]; then
  app_git remote set-url origin "$clean"
  ok "Remote normalizzato: $clean"
fi

if ! app_git diff --quiet || ! app_git diff --cached --quiet; then
  die "Modifiche locali non committate in $APP_DIR: annullale o committale, poi riprova."
fi

deploy() {
  GIT_SHA="$(app_git rev-parse HEAD)"
  export GIT_SHA
  $DC up -d --build && wait_healthy
}

# --- 1. backup: dump completo + backup applicativo (obbligatorio, salvo --force) -------
dump=""
if web_running; then
  log "Backup prima dell'aggiornamento…"
  dump="$DUMPS_DIR/pre-update-$(date +%Y%m%d-%H%M%S).sql.gz"
  if $DC exec -T web npm run backup >&2 && dump_db "$dump"; then
    ok "Backup creato (dump: $(basename "$dump"))."
    prune_keep "$DUMPS_DIR" 'pre-update-*.sql.gz' 5
  else
    rm -f "$dump"; dump=""
    if [ "$FORCE" -eq 1 ]; then warn "Backup non riuscito: proseguo perché hai usato --force."
    else die "Backup non riuscito: aggiornamento annullato (usa --force per procedere comunque)."; fi
  fi
else
  warn "Lo stack non è in esecuzione: salto il backup."
fi

# --- 2. codice -------------------------------------------------------------------
before_full="$(app_git rev-parse HEAD)"
log "Scarico gli aggiornamenti…"
app_git fetch --quiet origin main || die "Impossibile contattare GitHub (git fetch fallito). Se il repository è pubblico dovrebbe funzionare senza credenziali."
app_git merge --ff-only origin/main >&2 || die "Aggiornamento non fast-forward: ci sono commit locali sul server (controlla: git -C \"$APP_DIR\" status)."
after_full="$(app_git rev-parse HEAD)"
if [ "$before_full" = "$after_full" ]; then
  log "Già all'ultima versione ($(printf '%s' "$after_full" | cut -c1-7)). Ricostruisco comunque per sicurezza."
else
  log "Aggiornato: $(printf '%s' "$before_full" | cut -c1-7) → $(printf '%s' "$after_full" | cut -c1-7)"
fi

# --- 3. ricostruzione + verifica, con rollback automatico ---------------------------
log "Ricostruisco e riavvio i container…"
details="$(printf '{"from":"%s","to":"%s","dump":%s}' "$(printf '%s' "$before_full" | cut -c1-7)" "$(printf '%s' "$after_full" | cut -c1-7)" "$(json_str "$(basename "${dump:-}")")")"
if deploy; then
  job_finish ok "Soldi aggiornato a $(printf '%s' "$after_full" | cut -c1-7) e in salute." "$details"
fi

$DC logs --tail=40 web >&2 || true
if [ "$before_full" = "$after_full" ]; then
  die "Il container non è in salute (nessun codice da ripristinare). Ultimo dump: ${dump:-nessuno}."
fi
warn "Il container non è in salute: torno al commit precedente ($(printf '%s' "$before_full" | cut -c1-7))…"
app_git reset --hard "$before_full" >&2
if deploy; then
  job_finish fail "Aggiornamento FALLITO: ripristinata la versione precedente ($(printf '%s' "$before_full" | cut -c1-7)), il servizio è attivo. Controlla i log: soldi logs web" "$details"
fi
die "Aggiornamento E rollback falliti: il servizio potrebbe essere fermo. Ultimo dump: ${dump:-nessuno}. Controlla: soldi logs web"
