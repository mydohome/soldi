#!/usr/bin/env bash
# backup-plan.sh — sceglie quando far girare i backup e sistema il crontab.
#
# Guarda che cosa è già pianificato sulla macchina (il tuo crontab, /etc/crontab, /etc/cron.d e il
# backup interno dell'app, BACKUP_CRON), e PROPONE un orario libero, ad almeno 90 minuti dagli altri
# job. Poi chiede (con la proposta già pronta: basta Invio):
#   • a che ora fare il backup e in quali giorni (ogni giorno consigliato: perdita massima 24 ore);
#   • quanti dump (DUMP_KEEP) e quanti backup applicativi (BACKUP_KEEP) tenere;
# salva le scelte in ops.env (CRON_BACKUP_AT, CRON_BACKUP_DAYS, CRON_CHECK_AT, CRON_RESTORETEST_AT,
# DUMP_KEEP) e in .env (BACKUP_KEEP) e, dopo conferma, installa il crontab (soldi cron install).
# Si può rilanciare quando vuoi: i job di Soldi già installati non contano come «altri job».
#
# Uso: backup-plan.sh [--home <cartella>] [--yes] [--at HH:MM] [--days '*'|'1,3,5'|lun,mer,ven]
#                     [--dry-run] [--no-install]
#   --yes         accetta tutte le proposte senza chiedere (e installa il crontab, salvo --no-install)
#   --dry-run     mostra cosa troverebbe e cosa farebbe, senza scrivere nulla
# Per l'automazione: PLAN_STDIN=1 legge le risposte da stdin anche senza terminale.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

YES=0; DRY=0; NO_INSTALL=0; AT_ARG=""; DAYS_ARG=""; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    --at) AT_ARG="${2:-}"; shift 2 ;;
    --days) DAYS_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose
CRONTAB="${CRONTAB:-crontab}"
SYSTEM_CRON_FILES="${OPS_SYSTEM_CRON_FILES:-/etc/crontab /etc/cron.d/*}"

interactive() { [ "$YES" != 1 ] && { [ -t 0 ] || [ -n "${PLAN_STDIN:-}" ]; }; }
ask() { # prompt default → risposta
  local prompt="$1" def="${2:-}" reply=""
  if ! interactive; then printf '%s' "$def"; return 0; fi
  printf '%s [%s] ' "$prompt" "$def" >&2
  IFS= read -r reply || reply=""
  printf '%s' "${reply:-$def}"
}
say() { printf '%s\n' "$*" >&2; }

# ------------------------------------------------------------------ rilevamento dei job esistenti
# Normalizza le righe di cron con orario fisso in:  HH:MM <TAB> giorni (cifre 0-6) <TAB> origine <TAB> comando
# (orario con elenchi di numeri; i job a intervalli, come */5, non occupano uno slot). I giorni
# complessi (intervalli a-b, nomi) sono espansi; ciò che non si capisce vale «ogni giorno».
CRON_AWK='
function dowmask(f,   n, i, p, a, b, k, out, parts, r) {
  if (f == "*" || f ~ /\//) return "0123456"
  f = tolower(f)
  gsub(/sun/, "0", f); gsub(/mon/, "1", f); gsub(/tue/, "2", f); gsub(/wed/, "3", f)
  gsub(/thu/, "4", f); gsub(/fri/, "5", f); gsub(/sat/, "6", f)
  out = ""
  n = split(f, parts, ",")
  for (i = 1; i <= n; i++) {
    p = parts[i]
    if (p ~ /^[0-7]$/) { if (p == 7) p = 0; out = out p }
    else if (p ~ /^[0-7]-[0-7]$/) { split(p, r, "-"); a = r[1]; b = r[2]; if (b == 7) b = 0
      for (k = a; ; k = (k + 1) % 7) { out = out k; if (k == b) break } }
    else return "0123456"
  }
  return out == "" ? "0123456" : out
}
function nums(f,   n, parts, i) {
  if (f !~ /^[0-9]+(,[0-9]+)*$/) return 0
  return split(f, LIST, ",")
}
function emit(min, hour, dow, cmd,   nm, nh, i, j, M, H) {
  nh = nums(hour); for (i = 1; i <= nh; i++) H[i] = LIST[i]
  if (!nh) return
  nm = nums(min);  for (j = 1; j <= nm; j++) M[j] = LIST[j]
  if (!nm) return
  for (i = 1; i <= nh; i++) for (j = 1; j <= nm; j++)
    if (H[i] < 24 && M[j] < 60) printf "%02d:%02d\t%s\t%s\t%s\n", H[i], M[j], dowmask(dow), src, cmd
}
{
  line = $0; sub(/^[ \t]+/, "", line)
  if (line == "" || line ~ /^#/ || line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
  if (line ~ /^@/) {
    n = split(line, f, /[ \t]+/); cmd = ""; for (i = (sysfmt ? 3 : 2); i <= n; i++) cmd = cmd (cmd == "" ? "" : " ") f[i]
    if (f[1] == "@daily" || f[1] == "@midnight") emit(0, 0, "*", cmd)
    else if (f[1] == "@weekly") emit(0, 0, "0", cmd)
    next
  }
  n = split(line, f, /[ \t]+/)
  first = sysfmt ? 7 : 6
  if (n < first) next
  cmd = ""; for (i = first; i <= n; i++) cmd = cmd (cmd == "" ? "" : " ") f[i]
  emit(f[1], f[2], f[5], cmd)
}'

detect_jobs() { # → righe "HH:MM<TAB>giorni<TAB>origine<TAB>comando", ordinate
  local f u
  {
    u="$(id -un)"
    # crontab dell'utente, senza il blocco di Soldi (non è un «altro job»)
    "$CRONTAB" -l 2>/dev/null | awk -v b="# BEGIN soldi" -v e="# END soldi" 'index($0, b) == 1 { skip = 1; next } skip && $0 == e { skip = 0; next } !skip { print }' \
      | awk -v src="crontab di $u" -v sysfmt=0 "$CRON_AWK" || true
    # crontab di sistema (con il campo utente), se leggibili
    # shellcheck disable=SC2086
    for f in $SYSTEM_CRON_FILES; do
      [ -f "$f" ] && [ -r "$f" ] || continue
      awk -v src="$f" -v sysfmt=1 "$CRON_AWK" "$f" || true
    done
    # backup interno dell'app (BACKUP_CRON del .env): minuto ora * * giorni
    if [ "$(envval BACKUP_ENABLED)" != false ]; then
      local bc; bc="$(envval BACKUP_CRON)"; bc="${bc:-0 3 * * 0}"
      printf '%s soldi-app\n' "$bc" | awk -v src="backup interno di Soldi (BACKUP_CRON)" -v sysfmt=0 "$CRON_AWK" || true
    fi
  } | sort
}
looks_like_backup() { printf '%s' "$1" | grep -Eiq 'backup|dump|rsync|restic|borg|duplicity|snapshot'; }
day_label() { # 0123456 → «ogni giorno» / «lun, mer»
  local m="$1" out="" d names=(dom lun mar mer gio ven sab)
  [ "$m" = 0123456 ] && { printf 'ogni giorno'; return; }
  for d in 0 1 2 3 4 5 6; do case "$m" in *"$d"*) out="${out:+$out, }${names[$d]}" ;; esac; done
  printf '%s' "$out"
}
to_min() { echo $(( 10#${1%%:*} * 60 + 10#${1#*:} )); }
from_min() { printf '%02d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }

# Giorni scelti dall'utente → maschera 0-6. Accetta *, tutti, 1,3,5, lun,mer,ven.
parse_days() { # → "maschera|lista-cron"  oppure vuoto se non valido
  local s v part out="" cron=""
  s="$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' ')"
  case "$s" in ''|'*'|tutti|tutti-i-giorni|ogni-giorno|ognigiorno) echo "0123456|*"; return ;; esac
  for part in $(printf '%s' "$s" | tr ',' ' '); do
    case "$part" in
      dom|domenica|0|7) v=0 ;; lun|lunedi|lunedì|1) v=1 ;; mar|martedi|martedì|2) v=2 ;;
      mer|mercoledi|mercoledì|3) v=3 ;; gio|giovedi|giovedì|4) v=4 ;; ven|venerdi|venerdì|5) v=5 ;; sab|sabato|6) v=6 ;;
      *) return 0 ;;
    esac
    case "$out" in *"$v"*) ;; *) out="$out$v" ;; esac
  done
  [ -n "$out" ] || return 0
  cron="$(printf '%s' "$out" | sed 's/./&,/g; s/,$//')"
  echo "$out|$cron"
}
valid_time() { case "$1" in [0-9]:[0-5][0-9]|[01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) return 0 ;; *) return 1 ;; esac; }
norm_time() { printf '%02d:%02d' "$((10#${1%%:*}))" "$((10#${1#*:}))"; }

# Orario proposto: tra le 01:00 e le 05:30, il più vicino alle 03:15 fra quelli ad almeno 90 minuti da ogni altro
# job che gira negli stessi giorni (se non ce n'è, il più lontano possibile).
propose_time() { # maschera-giorni busy-file → "HH:MM distanza indice-del-più-vicino"
  awk -v cmask="$1" -v target=195 -v cap=90 '
    function overlap(a, b,   i) { for (i = 1; i <= length(a); i++) if (index(b, substr(a, i, 1))) return 1; return 0 }
    { split($1, t, ":"); bm[++n] = t[1] * 60 + t[2]; bd[n] = $2 }
    END {
      best = -1; bestscore = -1; bestgap = 99999
      for (t0 = 60; t0 <= 330; t0 += 15) {
        mind = 1440; near = 0
        for (i = 1; i <= n; i++) if (overlap(bd[i], cmask)) {
          d = t0 - bm[i]; if (d < 0) d = -d; if (d > 720) d = 1440 - d
          if (d < mind) { mind = d; near = i }
        }
        sc = mind >= cap ? cap : mind
        gap = t0 - target; if (gap < 0) gap = -gap
        if (sc > bestscore || (sc == bestscore && gap < bestgap)) { best = t0; bestscore = sc; bestgap = gap; bestmin = mind; bestnear = near }
      }
      printf "%02d:%02d %d %d\n", int(best / 60), best % 60, bestmin, bestnear
    }' "$2"
}

# ------------------------------------------------------------------ 1. che cosa c'è già
JOBS="$(mktemp "${TMPDIR:-/tmp}/soldi-plan.XXXXXX")"
trap 'rm -f "$JOBS"' EXIT
detect_jobs > "$JOBS"

say ""
say "Soldi — pianificazione dei backup"
say ""
if [ -s "$JOBS" ]; then
  say "Ho trovato questi job già pianificati su questa macchina:"
  n=0
  while IFS="$(printf '\t')" read -r when mask src cmd; do
    n=$((n + 1))
    tag=""; looks_like_backup "$cmd $src" && tag=" [backup]"
    short="$cmd"; [ "${#short}" -le 70 ] || short="${short:0:67}..."
    printf '  %2d) %s  %-11s %s%s\n      %s\n' "$n" "$when" "$(day_label "$mask")" "$src" "$tag" "$short" >&2
  done < "$JOBS"
else
  say "Non ho trovato altri job pianificati (nel crontab, in /etc/cron.d o nel backup interno dell'app)."
fi
if command -v systemctl >/dev/null 2>&1; then
  timers="$(systemctl list-timers --all --no-legend 2>/dev/null | grep -Ei 'backup|dump|restic|borg' | awk '{print $NF}' | head -5 || true)"
  [ -z "$timers" ] || say "
Timer di systemd con nomi simili a backup (non li considero nel calcolo): $(printf '%s' "$timers" | tr '\n' ' ')"
fi

# ------------------------------------------------------------------ 2. giorni e orario
cur_at="$(opsval CRON_BACKUP_AT)"; cur_days="$(opsval CRON_BACKUP_DAYS)"
say ""
days_in="${DAYS_ARG:-}"
if [ -z "$days_in" ]; then
  say "Giorni del backup. Ogni giorno è consigliato: la perdita massima di dati è 24 ore."
  days_in="$(ask 'Giorni (tutti, oppure es. lun,mer,ven)' "${cur_days:-tutti}")"
fi
parsed="$(parse_days "$days_in")"
[ -n "$parsed" ] || die "Giorni non validi: «$days_in» (usa «tutti» oppure es. lun,mer,ven o 1,3,5)."
DAYMASK="${parsed%%|*}"; DAYCRON="${parsed#*|}"
[ "$DAYMASK" = 0123456 ] || warn "Con $(day_label "$DAYMASK") la perdita massima di dati diventa l'intervallo più lungo tra due backup (fino a $([ "${#DAYMASK}" -le 2 ] && echo 'una settimana' || echo '3 giorni' ))."

read -r prop gap near < <(propose_time "$DAYMASK" "$JOBS")
if [ -s "$JOBS" ] && [ "$near" -gt 0 ]; then
  nsrc="$(sed -n "${near}p" "$JOBS" | cut -f3)"; nwhen="$(sed -n "${near}p" "$JOBS" | cut -f1)"
  why="a $gap minuti dal job più vicino ($nwhen, $nsrc)"
else why="nessun altro job rilevato negli stessi giorni"; fi
[ -z "$cur_at" ] || [ "$cur_at" = "$prop" ] || say "Orario attualmente impostato: $cur_at."
say "Orario proposto: $prop — $why."
if [ -n "$AT_ARG" ]; then at_in="$AT_ARG"; else at_in="$(ask 'Ora del backup (HH:MM)' "$prop")"; fi
valid_time "$at_in" || die "Orario non valido: «$at_in» (usa HH:MM, es. 03:15)."
AT="$(norm_time "$at_in")"

# avvisa se l'orario scelto è vicino a un altro job
close="$(awk -v at="$(to_min "$AT")" -v cmask="$DAYMASK" '
  function overlap(a, b,   i) { for (i = 1; i <= length(a); i++) if (index(b, substr(a, i, 1))) return 1; return 0 }
  { split($1, t, ":"); m = t[1] * 60 + t[2]; d = at - m; if (d < 0) d = -d; if (d > 720) d = 1440 - d
    if (d < 45 && overlap($2, cmask)) printf "%s (%s) ", $1, $3 }' "$JOBS")"
[ -z "$close" ] || warn "Attenzione: alle $AT girano anche: $close— con più backup insieme il disco e la CPU lavorano al massimo."

# ------------------------------------------------------------------ 3. gli altri orari
BK_MIN="$(to_min "$AT")"
if [ "$BK_MIN" -ge 360 ]; then CHECK="$(from_min $(( BK_MIN + 120 > 1439 ? 1439 : BK_MIN + 120 )))"; else CHECK="08:00"; fi
RT="05:00"
rt_gap=$(( $(to_min "$RT") - BK_MIN )); [ "$rt_gap" -ge 0 ] || rt_gap=$(( -rt_gap ))
[ "$rt_gap" -ge 60 ] || RT="06:00"
say ""
say "Altri orari (derivati dal backup):"
say "  controllo dei backup: $CHECK   ·   prova di ripristino: primo domenica del mese alle $RT   ·   sorveglianza: ogni 5 minuti"

# ------------------------------------------------------------------ 4. conservazione
dump_keep="$(opsval DUMP_KEEP)"; dump_keep="${dump_keep:-14}"
app_keep="$(envval BACKUP_KEEP)"; app_keep="${app_keep:-8}"
if [ "$DAYMASK" = 0123456 ]; then app_def=30; else app_def="$app_keep"; fi
[ "$app_keep" -ge "$app_def" ] 2>/dev/null && app_def="$app_keep"
say ""
say "Conservazione: dump giornalieri (DUMP_KEEP, ora $dump_keep) e backup applicativi (BACKUP_KEEP, ora $app_keep)."
[ "$DAYMASK" != 0123456 ] || [ "$app_keep" -ge 30 ] || say "  Con un backup al giorno 8 backup applicativi coprono solo 8 giorni: consiglio 30."
dump_keep="$(ask 'Dump da tenere' "$dump_keep")"
app_keep_new="$(ask 'Backup applicativi da tenere' "$app_def")"
case "$dump_keep$app_keep_new" in *[!0-9]*|'') die "Servono numeri interi per DUMP_KEEP e BACKUP_KEEP." ;; esac
[ "$dump_keep" -ge 1 ] && [ "$app_keep_new" -ge 1 ] || die "DUMP_KEEP e BACKUP_KEEP devono essere almeno 1."

# ------------------------------------------------------------------ 5. riepilogo e scrittura
say ""
say "Riepilogo:"
say "  backup: $(day_label "$DAYMASK") alle $AT   ·   controllo: $CHECK   ·   prova di ripristino: primo domenica alle $RT"
say "  conservazione: $dump_keep dump, $app_keep_new backup applicativi"
if [ "$DRY" = 1 ]; then say ""; say "--dry-run: nessuna modifica eseguita."; exit 0; fi
if interactive; then
  ans="$(ask 'Salvo queste scelte? (s/n)' s)"
  case "$ans" in [sSyY]*) ;; *) die "Annullato: nessuna modifica." ;; esac
fi

if [ ! -f "$OPS_ENV_FILE" ]; then
  if [ -f "$APP_DIR/ops.env.example" ]; then cp "$APP_DIR/ops.env.example" "$OPS_ENV_FILE"; else : > "$OPS_ENV_FILE"; fi
  chmod 600 "$OPS_ENV_FILE"
fi
set_kv "$OPS_ENV_FILE" CRON_BACKUP_AT "$AT"
set_kv "$OPS_ENV_FILE" CRON_BACKUP_DAYS "$DAYCRON"
set_kv "$OPS_ENV_FILE" CRON_CHECK_AT "$CHECK"
set_kv "$OPS_ENV_FILE" CRON_RESTORETEST_AT "$RT"
set_kv "$OPS_ENV_FILE" DUMP_KEEP "$dump_keep"
ok "Scelte salvate in ops.env."

env_changed=0
if [ "$app_keep_new" != "$(envval BACKUP_KEEP)" ]; then
  cp -p "$COMPOSE_DIR/.env" "$COMPOSE_DIR/.env.bak-$(date +%Y%m%d-%H%M%S)"
  set_kv "$COMPOSE_DIR/.env" BACKUP_KEEP "$app_keep_new"; chmod 600 "$COMPOSE_DIR/.env"
  env_changed=1
  ok "BACKUP_KEEP=$app_keep_new scritto nel .env (copia di sicurezza: .env.bak-…)."
fi

if [ "$NO_INSTALL" = 1 ]; then
  say ""; say "--no-install: il crontab non è stato toccato. Per applicare: soldi cron install"
else
  do_install=s
  if interactive; then
    say ""; say "Righe che verranno installate nel crontab:"; "$OPS_DIR/cron.sh" print --home "$COMPOSE_DIR" | sed 's/^/  /' >&2
    do_install="$(ask 'Installo il crontab ora? (s/n)' s)"
  fi
  case "$do_install" in
    [sSyY]*) "$OPS_DIR/cron.sh" install --home "$COMPOSE_DIR" ;;
    *) say "Crontab non modificato. Quando vuoi: soldi cron install" ;;
  esac
fi

if [ "$env_changed" = 1 ]; then
  say ""
  if interactive && [ "$(ask 'Riavvio il container web per applicare BACKUP_KEEP? (s/n)' s)" = s ]; then
    $DC up -d >&2 && ok "Container aggiornati."
  else
    warn "Per applicare BACKUP_KEEP al container: docker compose up -d"
  fi
fi
say ""
ok "Fatto. Controlla con: soldi status   ·   crontab -l"
