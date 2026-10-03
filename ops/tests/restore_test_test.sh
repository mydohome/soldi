#!/usr/bin/env bash
# Test di ops/restore-test.sh: sequenza, barriere di sicurezza, pulizia, --from-offsite.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

export RESTORETEST_DB_TRIES=3 RESTORETEST_DB_SLEEP=0

# Stack finto con un backup applicativo valido (users 2, transactions 10).
setup() {
  make_deploy; make_stack; make_curl_stub "$SB/cbin"
  printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
  d="$HOME_DIR/backups/soldi-backup-2026-10-01_03-00-00-000"; mkdir -p "$d"
  printf '{\n  "app": "soldi",\n  "tables": {\n    "users": { "rows": 2 },\n    "transactions": { "rows": 10 }\n  }\n}\n' > "$d/manifest.json"
  echo 2 > "$STUB_DIR/count.users"; echo 10 > "$STUB_DIR/count.transactions"
}
rtest() { "$OPS_REAL/restore-test.sh" "$@" >"$SB/out" 2>&1; echo $?; }
last_net() { docker_log | grep -o 'soldi-restoretest-net-[0-9a-f]*' | head -n 1; }

test_riuscito_sequenza_e_isolamento() {
  setup
  assert_eq "$(rtest)" 0
  log="$(docker_log)"
  assert_contains "$log" "network create --internal soldi-restoretest-net-"
  assert_contains "$log" "run -d --name soldi-restoretest-"
  assert_contains "$log" "postgres:16-alpine"
  assert_contains "$log" "--tmpfs /var/lib/postgresql/data"
  assert_not_contains "$log" " -p " "nessuna porta pubblicata"
  assert_not_contains "$log" "--publish"
  assert_contains "$log" "node src/db/migrate.js"
  assert_contains "$log" "node src/backup/restore.js /app/backups/soldi-backup-2026-10-01_03-00-00-000 --yes"
  assert_contains "$log" "sha256:testimage" "stessa immagine dell'app"
  assert_contains "$log" "$HOME_DIR/backups:/app/backups:ro" "backups montata in sola lettura"
  assert_contains "$log" "$HOME_DIR/app/src:/app/src:ro"
  assert_not_contains "$log" "$HOME_DIR/.env" "il .env di produzione non viene passato"
  assert_not_contains "$log" "--network proxy-net" "mai la rete di produzione"
  # ordine: migrate prima di restore
  assert_eq "$(docker_log | grep -n 'migrate.js\|restore.js' | cut -d: -f1 | tr '\n' ' ')" "$(docker_log | grep -n 'migrate.js\|restore.js' | cut -d: -f1 | sort -n | tr '\n' ' ')"
  assert_contains "$(cat "$HOME_DIR/ops-state/restore-test.json")" '"ok":true'
  assert_contains "$(cat "$HOME_DIR/ops-state/restore-test.json")" '"tables":2'
}
test_pulizia_dopo_successo() {
  setup; rtest >/dev/null
  assert_contains "$(docker_log)" "rm -f soldi-restoretest-"
  assert_contains "$(docker_log)" "network rm soldi-restoretest-net-"
  leftovers=0; for d in "${TMPDIR:-/tmp}"/soldi-restoretest.*; do [ -d "$d" ] && leftovers=1; done
  assert_eq "$leftovers" 0 "cartella temporanea rimossa"
}
test_ripristino_fallito_dopo_corruzione() {
  setup; echo 1 > "$STUB_DIR/restore_rc"
  assert_eq "$(rtest)" 1
  assert_contains "$(cat "$SB/out")" "IL RIPRISTINO DI PROVA È FALLITO"
  assert_contains "$(cat "$SB/out")" "produzione non è stato toccato"
  assert_contains "$(docker_log)" "network rm soldi-restoretest-net-" "pulizia anche dopo l'errore"
  assert_contains "$(cat "$HOME_DIR/ops-state/restore-test.json")" '"ok":false'
  assert_contains "$(cat "$CURL_STDIN")" "FALLITO" "notifica"
}
test_conteggi_diversi_dal_manifest() {
  setup; echo 9 > "$STUB_DIR/count.transactions"
  assert_eq "$(rtest)" 1
  assert_contains "$(cat "$SB/out")" "transactions (manifest 10, ripristinate 9)"
}
test_migrate_fallito() {
  setup; echo 1 > "$STUB_DIR/migrate_rc"
  assert_eq "$(rtest)" 1
  assert_not_contains "$(docker_log)" "restore.js" "senza schema non si prosegue"
}
test_diag_se_disponibile() {
  setup; mkdir -p "$HOME_DIR/app/scripts"; : > "$HOME_DIR/app/scripts/diag.js"
  assert_eq "$(rtest)" 0
  assert_contains "$(docker_log)" "node scripts/diag.js --data-only"
  echo 1 > "$STUB_DIR/diag_rc"; : > "$STUB_DIR/docker.log"
  assert_eq "$(rtest)" 1; assert_contains "$(cat "$SB/out")" "ERRORI nel database ripristinato"
  echo 2 > "$STUB_DIR/diag_rc"; : > "$STUB_DIR/docker.log"
  assert_eq "$(rtest)" 2 "diag con avvisi → avviso"
}
test_barriera_rete_non_isolata() {
  setup; echo false > "$STUB_DIR/net_internal"
  assert_eq "$(rtest)" 1
  assert_contains "$(cat "$SB/out")" "BARRIERA"
  assert_not_contains "$(docker_log)" "migrate.js" "nessuna operazione distruttiva"
  assert_not_contains "$(docker_log)" "restore.js"
}
test_barriera_container_di_produzione_in_rete() {
  setup; echo "soldi-db " > "$STUB_DIR/net_members"
  assert_eq "$(rtest)" 1
  assert_contains "$(cat "$SB/out")" "container estraneo (soldi-db)"
  assert_not_contains "$(docker_log)" "restore.js"
}
test_barriera_unit_pghost_e_nomi() {
  new_sandbox; make_deploy; make_stack
  run() { ( cd "$HOME_DIR" && bash -c ". '$OPS_REAL/lib.sh'; detect_layout; DOCKER='$DOCKER'; PROD_NAMES='soldi-web soldi-db'; $1" 2>&1 ); }
  out="$(run "assert_sandbox soldi-restoretest-abc soldi-restoretest-net-abc abc soldi-db")"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "PGHOST (soldi-db) non è il container temporaneo"
  out="$(run "assert_sandbox soldi-db soldi-restoretest-net-abc abc soldi-db")"; assert_contains "$out" "non ha il nome atteso"
  out="$(run "assert_sandbox soldi-restoretest-abc soldi-restoretest-net-abc abc soldi-restoretest-abc")"; rc=$?
  assert_rc "$rc" 0 "caso valido (rete isolata, membri vuoti)"
  echo "soldi-restoretest-abc " > "$STUB_DIR/net_members"
  out="$(run "assert_sandbox soldi-restoretest-abc soldi-restoretest-net-abc abc soldi-restoretest-abc")"; assert_rc $? 0 "il solo db temporaneo in rete va bene"
  printf 'proxy-net soldi-restoretest-net-abc ' > "$STUB_DIR/prod_networks"
  out="$(run "assert_sandbox soldi-restoretest-abc soldi-restoretest-net-abc abc soldi-restoretest-abc")"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "è collegato alla rete di prova"
}
test_nessun_backup() {
  setup; rm -rf "$HOME_DIR"/backups/soldi-backup-*
  assert_eq "$(rtest)" 1; assert_contains "$(cat "$SB/out")" "Nessun backup applicativo"
}
test_stack_non_in_esecuzione() {
  setup; make_stub "$SB/bin/docker" 'case "$*" in *"{{.Image}}"*) exit 1;; *) exit 0;; esac'
  assert_eq "$(rtest)" 1; assert_contains "$(cat "$SB/out")" "immagine dell'app"
}
test_from_offsite() {
  setup
  conf="RESTIC_REPOSITORY=sftp:u@h:/x\nRESTIC_PASSWORD_FILE=$SB/pw\n"; printf "$conf" >> "$HOME_DIR/ops.env"; printf pw > "$SB/pw"; chmod 600 "$SB/pw"
  # il finto restic ripristina uno snapshot con un backup diverso da quello locale
  make_stub "$SB/bin/restic" '
echo "$* | repo=${RESTIC_REPOSITORY:-}" >> "$STUB_DIR/restic.log"
if [ "$1" = restore ]; then
  tgt=""; while [ $# -gt 0 ]; do [ "$1" = --target ] && tgt="$2"; shift; done
  d="$tgt/srv/soldi/backups/soldi-backup-2026-09-30_03-00-00-000"; mkdir -p "$d"
  printf "{ \"app\": \"soldi\", \"tables\": { \"users\": { \"rows\": 2 }, \"transactions\": { \"rows\": 10 } } }" > "$d/manifest.json"
fi'
  assert_eq "$(rtest --from-offsite)" 0
  assert_contains "$(restic_log)" "restore latest --tag soldi --target"
  assert_contains "$(docker_log)" "restore.js /app/backups/soldi-backup-2026-09-30_03-00-00-000" "testa lo snapshot, non il backup locale"
  assert_not_contains "$(docker_log)" "$HOME_DIR/backups:/app/backups" "monta la cartella ripristinata da restic"
  assert_contains "$(cat "$HOME_DIR/ops-state/restore-test.json")" '"source":"offsite"'
}
test_from_offsite_non_configurato() {
  setup
  assert_eq "$(rtest --from-offsite)" 1; assert_contains "$(cat "$SB/out")" "NON è configurata"
}
test_ping_hc() {
  setup; printf 'HC_PING_URL_RESTORE_TEST=https://hc.example/rt-secret\n' >> "$HOME_DIR/ops.env"
  rtest >/dev/null
  assert_contains "$(cat "$CURL_STDIN")" 'rt-secret/start'
  assert_not_contains "$(cat "$CURL_ARGS")" "rt-secret"
}

run_tests
