#!/usr/bin/env bash
# restore-test.sh — dimostra che l'ultimo backup si ripristina DAVVERO, senza toccare
# il database di produzione.
#
#   • database temporaneo: postgres:16-alpine con dati in tmpfs, rete Docker --internal
#     usa-e-getta, nessuna porta pubblicata, nome casuale soldi-restoretest-<random>;
#   • stessa immagine dell'app (e src/ montato in sola lettura, come in produzione) in un
#     container usa-e-getta collegato SOLO alla rete temporanea: migrate.js e poi
#     restore.js <ultimo backup> --yes, con backups/ montata in sola lettura;
#   • barriere (assert_sandbox) prima di ogni operazione distruttiva: PGHOST deve essere il
#     container temporaneo, la rete isolata, nessun container di produzione collegato;
#   • confronto delle righe di ogni tabella con manifest.json e, se c'è, scripts/diag.js;
#   • pulizia garantita (trap) anche dopo errori o Ctrl+C.
#
# Uso: restore-test.sh [--from-offsite] [--home <cartella>]
#   --from-offsite  ripristina prima l'ultimo snapshot restic in una cartella temporanea e
#                   testa quello: verifica l'intera catena (copia remota → cifratura → ripristino)
# Uscita: 0 riuscito, 1 errore, 2 avviso.
set -euo pipefail
umask 077

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do _d="$(cd "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac; done
OPS_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=ops/lib.sh
. "$OPS_DIR/lib.sh"

FROM_OFFSITE=0; SOLDI_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-offsite) FROM_OFFSITE=1; shift ;;
    --home) SOLDI_HOME_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Argomento sconosciuto: $1" ;;
  esac
done
export SOLDI_HOME_ARG
detect_layout
choose_compose
JOB_NOTIFY_OK=1
job_begin restore-test
lock_acquire restore-test
RESTIC="${RESTIC:-restic}"

RT_RAND=""; RT_TMP=""; DB_NAME=""; NET=""; RUN_NAMES=""
ops_cleanup() {
  [ -n "$RT_RAND" ] || return 0
  # shellcheck disable=SC2086
  [ -z "$DB_NAME$RUN_NAMES" ] || "$DOCKER" rm -f $DB_NAME $RUN_NAMES >/dev/null 2>&1 || true
  [ -z "$NET" ] || "$DOCKER" network rm "$NET" >/dev/null 2>&1 || true
  [ -z "$RT_TMP" ] || rm -rf "$RT_TMP"
}

# --- origine del backup --------------------------------------------------------------
RT_RAND="$(rand_hex 6)"
RT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/soldi-restoretest.XXXXXX")"
source_kind=local
SRC_ROOT="$BACKUPS_DIR"
if [ "$FROM_OFFSITE" = 1 ]; then
  restic_configured || die "--from-offsite: la copia fuori macchina NON è configurata (RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE in ops.env, restic installato)."
  restic_export_env
  log "Ripristino l'ultimo snapshot restic in una cartella temporanea…"
  "$RESTIC" restore latest --tag soldi --target "$RT_TMP/offsite" >&2 || die "restic restore non riuscito: la copia fuori macchina NON è utilizzabile."
  SRC_ROOT="$(find_backups_root "$RT_TMP/offsite")"
  [ -n "$SRC_ROOT" ] || die "Lo snapshot restic non contiene backup applicativi (soldi-backup-*)."
  source_kind=offsite
fi
BACKUP_PATH="$(latest_app_backup "$SRC_ROOT")"
[ -n "$BACKUP_PATH" ] || die "Nessun backup applicativo (soldi-backup-*) in $SRC_ROOT."
BACKUP_NAME="$(basename "$BACKUP_PATH")"
MANIFEST="$BACKUP_PATH/manifest.json"
[ -f "$MANIFEST" ] || die "$BACKUP_NAME: manifest.json mancante."
log "Backup sotto prova: $BACKUP_NAME ($source_kind)"

# --- immagine e container di produzione ----------------------------------------------
WEB_CID="$($DC ps -q web 2>/dev/null || true)"; WEB_CID="${WEB_CID:-soldi-web}"
IMAGE="$("$DOCKER" inspect -f '{{.Image}}' "$WEB_CID" 2>/dev/null || true)"
[ -n "$IMAGE" ] || die "Non riesco a ricavare l'immagine dell'app dal container $WEB_CID (lo stack è in esecuzione?)."
PROD_NAMES="$(prod_container_names)"

# --- risorse temporanee ---------------------------------------------------------------
DB_NAME="soldi-restoretest-$RT_RAND"
NET="soldi-restoretest-net-$RT_RAND"
PG_IMAGE="${RESTORETEST_PG_IMAGE:-postgres:16-alpine}"
TEST_DB=soldi_restoretest; TEST_USER=soldi
TMP_PW="$(rand_hex 16)"
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$TEST_USER" "$TMP_PW" "$TEST_DB" > "$RT_TMP/dbenv"
{
  printf 'PGHOST=%s\nPGPORT=5432\nPGUSER=%s\nPGPASSWORD=%s\nPGDATABASE=%s\nBACKUP_DIR=/app/backups\n' "$DB_NAME" "$TEST_USER" "$TMP_PW" "$TEST_DB"
  # La chiave serve a verificare che le impostazioni cifrate si leggano dopo il ripristino.
  [ -z "$(envval SECRETS_KEY)" ] || printf 'SECRETS_KEY=%s\n' "$(envval SECRETS_KEY)"
} > "$RT_TMP/env"

log "Creo la rete isolata e il database temporaneo ($DB_NAME)…"
"$DOCKER" network create --internal "$NET" >/dev/null || die "Impossibile creare la rete di prova."
"$DOCKER" run -d --name "$DB_NAME" --network "$NET" --env-file "$RT_TMP/dbenv" \
  --tmpfs "/var/lib/postgresql/data:rw,size=${RESTORETEST_TMPFS_SIZE:-1g}" "$PG_IMAGE" >/dev/null \
  || die "Impossibile avviare il database temporaneo."
ready=0
for ((i = 0; i < ${RESTORETEST_DB_TRIES:-60}; i++)); do
  # via TCP: durante l'inizializzazione il server temporaneo ascolta solo sul socket
  if "$DOCKER" exec "$DB_NAME" pg_isready -h 127.0.0.1 -U "$TEST_USER" -d "$TEST_DB" >/dev/null 2>&1; then ready=1; break; fi
  sleep "${RESTORETEST_DB_SLEEP:-1}"
done
[ "$ready" = 1 ] || die "Il database temporaneo non è diventato pronto."

n_run=0
run_app() { # comando… — container usa-e-getta: stessa immagine, solo rete temporanea
  n_run=$((n_run + 1))
  local name="soldi-restoretest-run-$RT_RAND-$n_run"
  RUN_NAMES="$RUN_NAMES $name"
  local args=(run --rm --name "$name" --network "$NET" --env-file "$RT_TMP/env"
    --user "$(id -u):$(id -g)" --tmpfs /tmp
    -v "$SRC_ROOT:/app/backups:ro" -v "$APP_DIR/src:/app/src:ro")
  [ ! -d "$APP_DIR/scripts" ] || args+=(-v "$APP_DIR/scripts:/app/scripts:ro")
  "$DOCKER" "${args[@]}" "$IMAGE" "$@"
}
guard() { assert_sandbox "$DB_NAME" "$NET" "$RT_RAND" "$(read_kv "$RT_TMP/env" PGHOST)"; }

# --- ripristino -------------------------------------------------------------------------
guard
log "Schema (migrate.js) sul database temporaneo…"
run_app node src/db/migrate.js >&2 || die "migrate.js non riuscito sul database temporaneo."
guard
log "Ripristino di $BACKUP_NAME (restore.js --yes)…"
run_app node src/backup/restore.js "/app/backups/$BACKUP_NAME" --yes >&2 \
  || die "IL RIPRISTINO DI PROVA È FALLITO: il backup $BACKUP_NAME non si ripristina. Il database di produzione non è stato toccato."

# --- confronto con il manifest ------------------------------------------------------------
mismatch=""; tables=0
while read -r table expected; do
  [ -n "$table" ] || continue
  case "$table" in *[!a-z_]*) die "Nome di tabella non valido nel manifest: $table" ;; esac
  got="$("$DOCKER" exec "$DB_NAME" psql -U "$TEST_USER" -d "$TEST_DB" -tAc "SELECT count(*) FROM $table" 2>/dev/null | tr -d ' \r\n' || true)"
  tables=$((tables + 1))
  if [ "$got" != "$expected" ]; then mismatch="${mismatch:+$mismatch, }$table (manifest $expected, ripristinate ${got:-?})"; fi
done < <(manifest_tables "$MANIFEST")
[ "$tables" -gt 0 ] || die "manifest.json senza tabelle: backup non valido."
[ -z "$mismatch" ] || die "Conteggi diversi dal manifest: $mismatch."
ok "Conteggi di $tables tabelle uguali al manifest."

# --- diagnostica sul database ripristinato (se disponibile) --------------------------------
diag=skipped; status=ok
if [ -f "$APP_DIR/scripts/diag.js" ]; then
  guard
  log "Diagnostica sul database ripristinato…"
  rc=0; run_app node scripts/diag.js --data-only >&2 || rc=$?
  case "$rc" in
    0) diag=ok ;;
    2) diag=warn; status=warn ;;
    *) die "La diagnostica ha trovato ERRORI nel database ripristinato (vedi sopra)." ;;
  esac
fi

details="$(printf '{"backup":%s,"source":"%s","tables":%s,"diag":"%s"}' "$(json_str "$BACKUP_NAME")" "$source_kind" "$tables" "$diag")"
if [ "$status" = warn ]; then job_finish warn "Prova di ripristino riuscita con avvisi della diagnostica: $BACKUP_NAME ($source_kind)." "$details"; fi
job_finish ok "Prova di ripristino riuscita: $BACKUP_NAME ($source_kind), $tables tabelle verificate." "$details"
