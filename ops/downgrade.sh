#!/usr/bin/env bash
# downgrade.sh — ripristino di una versione precedente di Soldi (snapshot pre-update).
#
#   1. elenca o seleziona uno snapshot tag 'pre-update-*' (o commit) a cui tornare
#   2. crea un backup preventivo del database corrente (dump completo)
#   3. riporta il codice locale alla versione selezionata
#   4. ricostruisce i container e attende lo stato sano
#   5. opzionale: crea un commit di ripristino (revert) e sincronizza origin/main su GitHub
#
# Uso: downgrade.sh [--list] [--to <tag|commit>] [--yes] [--push] [--no-push] [--home <cartella>]
#   --list     mostra gli snapshot disponibili ed esce
#   --to       specifica direttamente il tag o commit di destinazione
#   --push     sincronizza anche il branch remoto su GitHub creando un commit di revert
#   --no-push  ripristina solo il server locale, senza toccare GitHub
#   --yes      non chiede conferme interattive (seleziona l'ultimo snapshot pre-update)
#   --home     cartella di installazione di Soldi
#
# Uscita: 0 ripristinato e in salute; 1 in caso di errore.

set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"

# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

LIST_ONLY=0; TARGET=""; ASSUME_YES=0; SYNC_PUSH=0; NO_PUSH=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1; shift ;;
    --to) TARGET="${2:?--to richiede un tag o commit}"; shift 2 ;;
    --push) SYNC_PUSH=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done

export SOLDI_HOME_ARG
detect_layout
choose_compose

git_ro() (
  umask 022
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true GIT_CONFIG_NOSYSTEM=1 \
    GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Soldi}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-soldi@localhost}" \
    GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Soldi}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-soldi@localhost}" \
    exec git -c credential.helper= -c 'http.https://github.com/.extraheader=' -c http.extraheader= "$@"
)
app_git() { git_ro -C "$APP_DIR" "$@"; }

get_snapshots() {
  app_git tag -l 'pre-update-*' --sort=-creatordate
}

# --- 0. Lista snapshot (--list) -----------------------------------------------
if [ "$LIST_ONLY" -eq 1 ]; then
  snaps="$(get_snapshots)"
  if [ -z "$snaps" ]; then
    log "Nessuno snapshot 'pre-update-*' trovato."
    log "Ultimi commit disponibili:"
    app_git log -n 5 --pretty=format:"  %h - %s (%cr)"
    echo
    exit 0
  fi
  printf "Snapshot pre-aggiornamento disponibili per il downgrade:\n"
  i=1
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    sha="$(app_git rev-parse --short "$tag")"
    date_str="$(app_git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M' "$tag" 2>/dev/null || true)"
    subj="$(app_git tag -l --format='%(contents:subject)' "$tag" 2>/dev/null || app_git log -1 --format=%s "$tag")"
    printf "  [%d] %-25s (commit %s · %s)\n      %s\n" "$i" "$tag" "$sha" "$date_str" "$subj"
    i=$((i + 1))
  done <<< "$snaps"
  exit 0
fi

# --- 1. Selezione versione di destinazione ------------------------------------
snaps="$(get_snapshots)"
if [ -z "$TARGET" ]; then
  if [ -z "$snaps" ]; then
    prev="$(app_git rev-parse --short HEAD~1 2>/dev/null || true)"
    [ -n "$prev" ] || die "Nessun commit precedente o snapshot pre-update a cui tornare."
    TARGET="$prev"
  else
    if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
      TARGET="$(head -n 1 <<< "$snaps")"
    else
      printf "\nVersioni precedenti disponibili per il downgrade:\n"
      declare -a snap_array=()
      i=1
      while IFS= read -r tag; do
        [ -n "$tag" ] || continue
        snap_array+=("$tag")
        sha="$(app_git rev-parse --short "$tag")"
        date_str="$(app_git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M' "$tag" 2>/dev/null || true)"
        printf "  [%d] %-24s (commit %s · %s)\n" "$i" "$tag" "$sha" "$date_str"
        i=$((i + 1))
      done <<< "$snaps"
      printf "  [0] Annulla\n\n"
      printf "A quale versione vuoi tornare? [1]: "
      read -r choice
      choice="${choice:-1}"
      if [ "$choice" = "0" ]; then
        die "Operazione annullata dall'utente."
      fi
      idx=$((choice - 1))
      if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#snap_array[@]}" ]; then
        die "Scelta non valida: $choice"
      fi
      TARGET="${snap_array[$idx]}"
    fi
  fi
fi

target_commit="$(app_git rev-parse --verify "$TARGET^{commit}" 2>/dev/null)" || die "Versione o commit non valido: $TARGET"
current_commit="$(app_git rev-parse HEAD)"

if [ "$target_commit" = "$current_commit" ]; then
  die "Il server si trova già alla versione selezionata ($TARGET · $(cut -c1-7 <<< "$target_commit"))."
fi

target_short="$(cut -c1-7 <<< "$target_commit")"
current_short="$(cut -c1-7 <<< "$current_commit")"

if ! app_git diff --quiet || ! app_git diff --cached --quiet; then
  die "Modifiche locali non committate in $APP_DIR: annullale o committale, poi riprova."
fi

JOB_NOTIFY_OK=1
job_begin downgrade
lock_acquire update

log "Inizio downgrade: $current_short → $target_short ($TARGET)"

# --- 2. Backup preventivo completo del database -------------------------------
dump=""
if web_running; then
  log "Backup di sicurezza prima del downgrade…"
  dump="$DUMPS_DIR/pre-downgrade-$(date +%Y%m%d-%H%M%S).sql.gz"
  if $DC exec -T web npm run backup >&2 && dump_db "$dump"; then
    ok "Backup creato (dump: $(basename "$dump"))."
    prune_keep "$DUMPS_DIR" 'pre-downgrade-*.sql.gz' 5
  else
    warn "Backup del database non riuscito: procedo comunque con cautela."
  fi
else
  warn "Lo stack non è in esecuzione: salto il backup preventivo."
fi

deploy() {
  GIT_SHA="$(app_git rev-parse HEAD)"
  export GIT_SHA
  $DC up -d --build && wait_healthy
}

# --- 3. Determinazione modalità di downgrade (con revert su GitHub o solo locale) ---
do_push=0
if [ "$NO_PUSH" -ne 1 ]; then
  if [ "$SYNC_PUSH" -eq 1 ]; then
    do_push=1
  elif [ -t 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
    printf '\nVuoi allineare anche GitHub (origin/main) creando un commit di ripristino (revert)? [s/N]: '
    read -r ans
    case "$ans" in [sSyY]*) do_push=1 ;; *) do_push=0 ;; esac
  fi
fi

if [ "$do_push" -eq 1 ]; then
  log "Creo commit di ripristino (revert) per allineare origin/main a $TARGET ($target_short)…"
  app_git read-tree -u --reset "$target_commit"
  revert_msg="revert: ripristino versione $TARGET ($target_short) da ./soldi downgrade"
  GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Soldi}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-soldi@localhost}" \
  GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Soldi}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-soldi@localhost}" \
  app_git commit -m "$revert_msg" >&2 || true
else
  log "Ripristino del codice locale a $TARGET ($target_short)…"
  app_git reset --hard "$target_commit" >&2
fi

# --- 4. Ricostruzione container e verifica -----------------------------------
log "Ricostruisco e riavvio i container…"
details="$(printf '{"from":"%s","to":"%s","dump":%s}' "$current_short" "$target_short" "$(json_str "$(basename "${dump:-}")")")"

if deploy; then
  ok "Soldi ripristinato con successo a $TARGET ($target_short) e in salute."
else
  warn "Il container non è in salute dopo il downgrade: torno al commit di partenza ($current_short)…"
  app_git reset --hard "$current_commit" >&2
  deploy || true
  die "Downgrade FALLITO: il container non è risultato sano dopo la ricostruzione."
fi

# --- 5. Push su GitHub se richiesto -------------------------------------------
if [ "$do_push" -eq 1 ]; then
  log "Invio commit di ripristino su GitHub (origin/main)…"
  if app_git push origin main >&2; then
    ok "GitHub (main) sincronizzato con successo con la versione $target_short."
  else
    warn "Impossibile inviare a GitHub (potrebbero mancare le credenziali di scrittura)."
    warn "Il server locale è comunque alla versione corretta ($target_short)."
    warn "Per allineare GitHub manualmente: git push origin main"
  fi
else
  log "GitHub non modificato. Il server locale è ora alla versione $target_short."
fi

job_finish ok "Downgrade a $target_short completato con successo." "$details"
