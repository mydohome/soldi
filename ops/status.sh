#!/usr/bin/env bash
# status.sh — quadro d'insieme: container, versione dell'app, età di ultimo backup / dump /
# copia fuori macchina / prova di ripristino, spazio disco, riepilogo della diagnostica e avvisi.
# Uscita: 0 nessun avviso, 2 almeno un avviso.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose

WARNS=""
warn_add() { WARNS="${WARNS}  - $1"$'\n'; }
ago() { # epoch → "3 ore fa"
  local d=$(( $(now_epoch) - $1 ))
  if [ "$d" -lt 3600 ]; then echo "$((d / 60)) min fa"
  elif [ "$d" -lt 172800 ]; then echo "$((d / 3600)) ore fa"
  else echo "$((d / 86400)) giorni fa"; fi
}
section() { printf '\n%s\n' "$1"; }

echo "Soldi — stato ($LAYOUT: $COMPOSE_DIR)"

section "Container"
$DC ps 2>/dev/null | sed 's/^/  /' || true
web_state="$(service_health web)"; db_state="$(service_health db)"
printf '  web: %s · db: %s\n' "$web_state" "$db_state"
case "$web_state" in healthy|none) ;; *) warn_add "il container web non è in salute ($web_state): soldi logs web" ;; esac
case "$db_state" in healthy|none) ;; *) warn_add "il container db non è in salute ($db_state): soldi logs db" ;; esac

section "App"
sha="$(git -C "$APP_DIR" log -1 --format='%h del %cd' --date=short 2>/dev/null || true)"
printf '  versione: %s\n' "${sha:-sconosciuta}"

section "Backup"
d="$(latest_app_backup)"
if [ -n "$d" ] && [ -f "$d/manifest.json" ]; then printf '  applicativo: %s (%s)\n' "$(basename "$d")" "$(ago "$(file_mtime "$d/manifest.json")")"
else printf '  applicativo: MAI\n'; warn_add "nessun backup applicativo: soldi backup"; fi
f="$(latest_file "$DUMPS_DIR" 'soldi-*.sql.gz')"
if [ -n "$f" ]; then printf '  dump:        %s (%s)\n' "$(basename "$f")" "$(ago "$(file_mtime "$f")")"
else printf '  dump:        MAI\n'; warn_add "nessun dump PostgreSQL: soldi backup"; fi
if [ -n "$(opsval RESTIC_REPOSITORY)" ]; then
  if [ "$(state_field offsite ok)" = true ]; then printf '  fuori macchina: ultima copia %s\n' "$(ago "$(iso_to_epoch "$(state_field offsite finishedAt)")")"
  elif [ -f "$STATE_DIR/offsite.json" ]; then printf '  fuori macchina: ULTIMA COPIA FALLITA\n'; warn_add "l'ultima copia fuori macchina è fallita: soldi offsite"
  else printf '  fuori macchina: mai eseguita\n'; warn_add "copia fuori macchina mai eseguita: soldi offsite"; fi
else printf '  fuori macchina: NON configurata\n'; warn_add "copia fuori macchina non configurata (RESTIC_REPOSITORY in ops.env)"; fi
if [ -f "$STATE_DIR/restore-test.json" ]; then
  if [ "$(state_field restore-test ok)" = true ]; then printf '  prova di ripristino: riuscita %s\n' "$(ago "$(iso_to_epoch "$(state_field restore-test finishedAt)")")"
  else printf '  prova di ripristino: FALLITA\n'; warn_add "l'ultima prova di ripristino è FALLITA: soldi restore-test"; fi
else printf '  prova di ripristino: mai eseguita\n'; warn_add "prova di ripristino mai eseguita: soldi restore-test"; fi

section "Spazio disco"
free="$(disk_free_pct "$BACKUPS_DIR")"
printf '  backup: %s%% liberi\n' "$free"
[ "$free" -ge "${DISK_WARN_PCT:-15}" ] || warn_add "poco spazio sul disco dei backup (${free}%)"

section "Diagnostica"
rc=0; out="$(run_diag_json 2>/dev/null)" || rc=$?
if [ "$rc" -eq 3 ]; then printf '  non disponibile nell'"'"'immagine (richiede la ricostruzione: soldi update)\n'
else
  summary="$(printf '%s' "$out" | grep -oE '"summary":\{"ok":[0-9]+,"warn":[0-9]+,"error":[0-9]+\}' | head -n 1 || true)"
  if [ -n "$summary" ]; then
    n_ok="$(printf '%s' "$summary" | grep -oE '"ok":[0-9]+' | cut -d: -f2)"; n_w="$(printf '%s' "$summary" | grep -oE '"warn":[0-9]+' | cut -d: -f2)"; n_e="$(printf '%s' "$summary" | grep -oE '"error":[0-9]+' | cut -d: -f2)"
    printf '  %s ok, %s avvisi, %s errori (dettagli: soldi diag)\n' "$n_ok" "$n_w" "$n_e"
    [ "$n_w" -eq 0 ] || warn_add "la diagnostica ha $n_w avvisi: soldi diag"
    [ "$n_e" -eq 0 ] || warn_add "la diagnostica ha $n_e ERRORI: soldi diag"
  else printf '  non eseguibile (il container web è attivo?)\n'; warn_add "diagnostica non eseguibile"; fi
fi

section "Avvisi"
if [ -z "$WARNS" ]; then echo "  nessuno"; exit 0; fi
printf '%s' "$WARNS"
exit 2
