#!/usr/bin/env bash
# Test di ops/notify.sh: token fuori dagli argomenti, anti-spam, coda in uscita.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

setup_tg() {
  make_deploy; make_curl_stub "$SB/bin"
  printf 'ALERT_TG_TOKEN=123456:SECRET-token\nALERT_TG_CHAT=-1001\n' > "$HOME_DIR/ops.env"
}
notify() { "$OPS_REAL/notify.sh" "$@" 2>/dev/null; }
sends() { grep -c '^----$' "$CURL_STDIN" || true; }

test_token_solo_su_stdin() {
  setup_tg
  notify "backup fallito" --level error --job backup; rc=$?
  assert_rc "$rc" 0
  assert_eq "$(sends)" 1
  assert_not_contains "$(cat "$CURL_ARGS")" "SECRET-token" "il token non deve comparire negli argomenti"
  assert_not_contains "$(cat "$CURL_ARGS")" "-1001" "nemmeno il chat id"
  assert_contains "$(cat "$CURL_ARGS")" "-K -" "configurazione da stdin"
  stdin="$(cat "$CURL_STDIN")"
  assert_contains "$stdin" "bot123456:SECRET-token/sendMessage"
  assert_contains "$stdin" "chat_id=-1001"
  assert_contains "$stdin" "backup fallito"
}
test_messaggio_con_host_job_e_livello() {
  setup_tg
  notify "ciao" --level warn --job offsite
  stdin="$(cat "$CURL_STDIN")"
  assert_contains "$stdin" "$(hostname -s 2>/dev/null || hostname)"
  assert_contains "$stdin" "offsite"
  assert_contains "$stdin" "AVVISO"
  notify "ciao" --level error --job x; assert_contains "$(cat "$CURL_STDIN")" "ERRORE"
  notify "ciao" --level info --job x;  assert_contains "$(cat "$CURL_STDIN")" "INFO"
}
test_escape_virgolette_e_a_capo() {
  setup_tg
  notify 'riga "uno"
riga\due'
  stdin="$(cat "$CURL_STDIN")"
  assert_contains "$stdin" 'riga \"uno\"\nriga\\due'
  assert_eq "$(grep -c '^data-urlencode = "text=' "$CURL_STDIN")" 1 "una sola direttiva text= (nessuna iniezione di righe)"
}
test_il_token_nel_messaggio_viene_oscurato() {
  setup_tg
  notify "errore con 123456:SECRET-token dentro"
  assert_not_contains "$(grep '^data-urlencode = "text=' "$CURL_STDIN")" "SECRET-token"
}
test_non_configurato_scrive_su_stderr_e_non_fallisce() {
  make_deploy; make_curl_stub "$SB/bin"
  out="$("$OPS_REAL/notify.sh" "ciao" --level error 2>&1)"; rc=$?
  assert_rc "$rc" 0
  assert_contains "$out" "Telegram non configurato"
  assert_eq "$(sends)" 0
}
test_anti_spam_con_key_e_once_per() {
  setup_tg
  OPS_NOW=1000000 notify "problema" --key disco --once-per 24
  OPS_NOW=1003600 notify "problema" --key disco --once-per 24
  assert_eq "$(sends)" 1 "dentro le 24 ore: un solo invio"
  assert_file "$HOME_DIR/ops-state/notify-disco.stamp"
  OPS_NOW=1086401 notify "problema" --key disco --once-per 24
  assert_eq "$(sends)" 2 "dopo 24 ore: di nuovo"
  OPS_NOW=1086402 notify "altro" --key altra --once-per 24
  assert_eq "$(sends)" 3 "chiave diversa: indipendente"
  notify "senza chiave"; notify "senza chiave"
  assert_eq "$(sends)" 5 "senza --key non c'è limite"
}
test_chiave_sanificata() {
  setup_tg
  notify "x" --key '../../etc/passwd' --once-per 1
  assert_no_file "$HOME_DIR/ops-state/../../etc/passwd.stamp"
  n=0; for f in "$HOME_DIR"/ops-state/notify-*.stamp; do [ -f "$f" ] && n=$((n + 1)); done
  assert_eq "$n" 1
}
test_coda_in_uscita_e_reinvio() {
  setup_tg
  echo 22 > "$CURL_RC_FILE"
  OPS_NOW=2000000 notify "primo"; rc=$?
  assert_rc "$rc" 0 "non fa fallire il chiamante"
  OPS_NOW=2000010 notify "secondo"
  n=0; for f in "$HOME_DIR"/ops-state/outbox/*.msg; do [ -f "$f" ] && n=$((n + 1)); done
  assert_eq "$n" 2 "due messaggi in coda"
  echo 0 > "$CURL_RC_FILE"; : > "$CURL_STDIN"
  OPS_NOW=2000100 notify "terzo"
  assert_eq "$(sends)" 3 "coda svuotata + nuovo messaggio"
  assert_contains "$(cat "$CURL_STDIN")" "(in ritardo)"
  n=0; for f in "$HOME_DIR"/ops-state/outbox/*.msg; do [ -f "$f" ] && n=$((n + 1)); done
  assert_eq "$n" 0
}
test_coda_tetto_50_e_scadenza_48_ore() {
  setup_tg
  echo 22 > "$CURL_RC_FILE"
  for i in $(seq 1 55); do OPS_NOW=$((3000000 + i)) notify "msg $i"; done
  n=0; for f in "$HOME_DIR"/ops-state/outbox/*.msg; do [ -f "$f" ] && n=$((n + 1)); done
  assert_eq "$n" 50 "al massimo 50 messaggi"
  assert_eq "$(cat "$HOME_DIR"/ops-state/outbox/*.msg | grep -c '^msg 1$')" 0 "si perdono i più vecchi"
  assert_eq "$(cat "$HOME_DIR"/ops-state/outbox/*.msg | grep -c '^msg 55$')" 1 "restano i più recenti"
  echo 0 > "$CURL_RC_FILE"; : > "$CURL_STDIN"
  OPS_NOW=$((3000055 + 48 * 3600 + 100)) notify "tardi"
  assert_eq "$(sends)" 1 "i messaggi scaduti (48 ore) vengono scartati, non inviati"
}
test_layout_non_trovato_non_fallisce() {
  new_sandbox; unset SOLDI_HOME
  out="$(cd "$SB" && OPS_DIR="$SB" "$OPS_REAL/notify.sh" "x" 2>&1)"; rc=$?
  assert_rc "$rc" 0
}

run_tests
