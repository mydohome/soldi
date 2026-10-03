#!/usr/bin/env bash
# Test di ops/soldi (dispatcher) e ops/notify-test.sh.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

setup() { make_deploy; make_stack; make_curl_stub "$SB/cbin"; printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"; }
sends() { grep -c '^----$' "$CURL_STDIN" || true; }

test_help_e_comando_sconosciuto() {
  setup
  out="$("$OPS_REAL/soldi" help 2>&1)"; assert_contains "$out" "backup"; assert_contains "$out" "notify-test"; assert_contains "$out" "docs/OPERATIONS.md"
  out="$("$OPS_REAL/soldi" boh 2>&1)"; rc=$?; assert_rc "$rc" 1; assert_contains "$out" "comando sconosciuto"
}
test_inoltra_ai_script_e_con_link_simbolico() {
  setup; unset SOLDI_HOME
  ln -s app/ops/soldi "$HOME_DIR/soldi"
  # il link nella cartella di deploy funziona anche da un'altra directory
  out="$(cd "$SB" && "$HOME_DIR/soldi" backup 2>&1)"; rc=$?
  assert_rc "$rc" 0
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/soldi-*.sql.gz)" 1
  out="$(cd "$SB" && "$HOME_DIR/soldi" check 2>&1)"; assert_contains "$out" "ultimo backup applicativo"
  out="$("$OPS_REAL/soldi" --home "$HOME_DIR" watch 2>&1)"; assert_contains "$out" "container web"
}
test_logs() {
  setup
  "$OPS_REAL/soldi" logs web >/dev/null 2>&1
  "$OPS_REAL/soldi" logs -f db >/dev/null 2>&1
  assert_contains "$(dc_log)" "logs --tail=200 web"
  assert_contains "$(dc_log)" "logs --tail=200 -f db"
}
test_notify_test_tre_livelli() {
  setup
  out="$("$OPS_REAL/notify-test.sh" 2>&1)"; rc=$?
  assert_rc "$rc" 0
  assert_eq "$(sends)" 3
  assert_contains "$(cat "$CURL_STDIN")" "INFO"; assert_contains "$(cat "$CURL_STDIN")" "AVVISO"; assert_contains "$(cat "$CURL_STDIN")" "ERRORE"
  assert_contains "$out" "[info] inviato"; assert_contains "$out" "[error] inviato"
}
test_notify_test_canale_giu() {
  setup; echo 22 > "$CURL_RC_FILE"
  out="$("$OPS_REAL/notify-test.sh" 2>&1)"; rc=$?
  assert_rc "$rc" 1
  assert_contains "$out" "NON inviato"
  assert_contains "$out" "ops-state/outbox"
}
test_notify_test_non_configurato() {
  setup; rm "$HOME_DIR/ops.env"
  out="$("$OPS_REAL/notify-test.sh" 2>&1)"; rc=$?
  assert_rc "$rc" 1; assert_contains "$out" "NON è configurato"; assert_eq "$(sends)" 0
}
test_notify_test_simulate_fault() {
  setup
  "$OPS_REAL/notify-test.sh" --simulate-fault >/dev/null 2>&1; rc=$?
  assert_rc "$rc" 0
  assert_eq "$(sends)" 3
  assert_contains "$(cat "$CURL_STDIN")" "SIMULAZIONE"
}

run_tests
