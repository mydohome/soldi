#!/usr/bin/env bash
# Test di ops/watch.sh: macchina a stati degli avvisi, riavvii, disco, job, riavvio host.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

setup() {
  make_deploy; make_stack; make_curl_stub "$SB/cbin"
  printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
  export DISK_WARN_PCT=0 DISK_ERR_PCT=0   # il disco della macchina di test non c'entra
  export OPS_PROC_UPTIME="$SB/uptime"; echo "999999.00 1.00" > "$OPS_PROC_UPTIME"
  T0=1800000000
}
watch() { OPS_NOW="$1" "$OPS_REAL/watch.sh" >"$SB/out" 2>&1; echo $?; }
msgs() { grep -c '^----$' "$CURL_STDIN" || true; }
last_msg() { awk 'BEGIN{RS="----\n"} {last=$0} END{printf "%s", last}' "$CURL_STDIN"; }

test_sano_nessun_messaggio() {
  setup
  assert_eq "$(watch $T0)" 0
  assert_eq "$(msgs)" 0
  assert_contains "$(cat "$HOME_DIR/ops-state/watch.json")" '"job":"watch","ok":true'
  assert_contains "$(cat "$HOME_DIR/ops-state/watch.json")" '"svc_web":{"fails":0'
  assert_contains "$(cat "$SB/out")" "container web in esecuzione e sano"
  assert_contains "$(cat "$SB/out")" "PostgreSQL accetta connessioni"
  assert_contains "$(dc_log)" "exec -T db pg_isready"
  assert_contains "$(dc_log)" "exec -T web node -e"
}
test_un_solo_fallimento_nessun_messaggio_due_fallimenti_uno() {
  setup; echo unhealthy > "$STUB_DIR/inspect.out.web"
  assert_eq "$(watch $T0)" 1
  assert_eq "$(msgs)" 0 "un solo controllo fallito: nessun messaggio (aggiornamento/riavvio in corso?)"
  watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 1 "due controlli consecutivi: un messaggio"
  m="$(last_msg)"
  assert_contains "$m" "web NON sano"
  assert_contains "$m" "soldi logs web" "suggerimento"
  assert_contains "$m" "ERRORE"
  watch $((T0 + 600)) >/dev/null
  assert_eq "$(msgs)" 1 "finché dura, niente ripetizioni"
}
test_fallimento_che_rientra_prima_di_due_controlli() {
  setup; echo unhealthy > "$STUB_DIR/inspect.out.web"
  watch $T0 >/dev/null
  echo healthy > "$STUB_DIR/inspect.out.web"
  watch $((T0 + 300)) >/dev/null
  echo unhealthy > "$STUB_DIR/inspect.out.web"
  watch $((T0 + 600)) >/dev/null
  assert_eq "$(msgs)" 0 "i fallimenti non consecutivi non contano"
}
test_promemoria_dopo_6_ore_e_non_prima() {
  setup; echo unhealthy > "$STUB_DIR/inspect.out.web"
  watch $T0 >/dev/null; watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 1
  watch $((T0 + 300 + 6 * 3600 - 1)) >/dev/null
  assert_eq "$(msgs)" 1 "a 5h59: niente"
  watch $((T0 + 300 + 6 * 3600)) >/dev/null
  assert_eq "$(msgs)" 2 "a 6h: promemoria"
  assert_contains "$(last_msg)" "Promemoria"
  watch $((T0 + 300 + 6 * 3600 + 300)) >/dev/null
  assert_eq "$(msgs)" 2 "subito dopo: niente"
  watch $((T0 + 300 + 12 * 3600)) >/dev/null
  assert_eq "$(msgs)" 3 "altre 6 ore: un altro promemoria"
}
test_rientro_con_durata() {
  setup; echo unhealthy > "$STUB_DIR/inspect.out.db"
  watch $T0 >/dev/null; watch $((T0 + 300)) >/dev/null
  echo healthy > "$STUB_DIR/inspect.out.db"
  watch $((T0 + 300 + 3 * 3600)) >/dev/null
  assert_eq "$(msgs)" 2
  m="$(last_msg)"
  assert_contains "$m" "Ripristinato"
  assert_contains "$m" "container db"
  assert_contains "$m" "3 h" "durata del guasto"
  assert_contains "$m" "INFO"
  watch $((T0 + 300 + 3 * 3600 + 300)) >/dev/null
  assert_eq "$(msgs)" 2 "nessun altro messaggio dopo il rientro"
}
test_container_fermo() {
  setup; make_stub "$SB/bin/dc" 'echo "$*" >> "$STUB_DIR/dc.log"; case "$*" in "ps -q web") ;; "ps -q db") echo cid-db ;; *) exit 0 ;; esac'
  watch $T0 >/dev/null; watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 1
  assert_contains "$(last_msg)" "web NON in esecuzione"
  assert_not_contains "$(cat "$SB/out")" "/api/health non risponde" "niente doppioni se il container non c'è"
}
test_senza_healthcheck_sonda_di_riserva() {
  setup; echo none > "$STUB_DIR/inspect.out"
  assert_eq "$(watch $T0)" 0
  assert_contains "$(cat "$SB/out")" "senza HEALTHCHECK: vale la sonda"
  assert_contains "$(cat "$SB/out")" "l'endpoint /api/health risponde"
  echo 1 > "$STUB_DIR/probe_rc"
  watch $((T0 + 300)) >/dev/null; watch $((T0 + 600)) >/dev/null
  assert_eq "$(msgs)" 1 "un solo avviso (nessun doppione)"
  assert_contains "$(last_msg)" "/api/health non risponde"
}
test_pg_isready_e_endpoint() {
  setup; echo 1 > "$STUB_DIR/pgready_rc"
  watch $T0 >/dev/null; watch $((T0 + 300)) >/dev/null
  assert_contains "$(cat "$CURL_STDIN")" "pg_isready"
  setup; echo 1 > "$STUB_DIR/probe_rc"
  watch $T0 >/dev/null; watch $((T0 + 300)) >/dev/null
  assert_contains "$(cat "$CURL_STDIN")" "/api/health non risponde"
}
test_riavvii_a_ripetizione() {
  setup
  watch $T0 >/dev/null
  assert_contains "$(cat "$HOME_DIR/ops-state/watch.json")" '"restarts":{"web":0,"db":0}'
  echo 3 > "$STUB_DIR/restart_count.web"
  watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 0 "un solo riavvio (es. aggiornamento): nessun messaggio"
  echo 3 > "$STUB_DIR/restart_count.web"
  watch $((T0 + 600)) >/dev/null
  assert_eq "$(msgs)" 0 "contatore fermo: il problema rientra"
  echo 5 > "$STUB_DIR/restart_count.web"; watch $((T0 + 900)) >/dev/null
  echo 7 > "$STUB_DIR/restart_count.web"; watch $((T0 + 1200)) >/dev/null
  assert_eq "$(msgs)" 1 "riavvii in aumento in due controlli di fila: avviso"
  assert_contains "$(last_msg)" "si è riavviato 2 volte"
  assert_contains "$(last_msg)" "AVVISO"
}
test_disco_quasi_pieno() {
  setup
  DISK_ERR_PCT=101 watch $T0 >/dev/null; DISK_ERR_PCT=101 watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 1
  assert_contains "$(last_msg)" "spazio libero"
  assert_contains "$(last_msg)" "dei backup"
  setup; DISK_WARN_PCT=101 watch $T0 >/dev/null; DISK_WARN_PCT=101 watch $((T0 + 300)) >/dev/null
  assert_contains "$(last_msg)" "AVVISO" "sopra la soglia di errore ma sotto quella di avviso"
}
test_disco_di_docker() {
  setup; mkdir -p "$SB/docker-root"; export STUB_DOCKER_ROOT="$SB/docker-root"
  DISK_ERR_PCT=101 watch $T0 >/dev/null; DISK_ERR_PCT=101 watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 2 "un messaggio per disco (backups e Docker)"
  assert_contains "$(cat "$CURL_STDIN")" "sul disco di Docker"
  assert_contains "$(cat "$CURL_STDIN")" "sul disco dei backup"
}
test_riavvio_host_una_sola_volta() {
  setup
  watch $T0 >/dev/null
  assert_eq "$(msgs)" 0
  echo "120.50 10.0" > "$OPS_PROC_UPTIME"
  watch $((T0 + 3600)) >/dev/null
  assert_eq "$(msgs)" 1 "uptime < 10 minuti e precedente più vecchia: segnala"
  assert_contains "$(last_msg)" "host è stato riavviato"
  assert_contains "$(last_msg)" "web healthy"
  echo "420.0 10.0" > "$OPS_PROC_UPTIME"
  watch $((T0 + 3900)) >/dev/null
  assert_eq "$(msgs)" 1 "ancora uptime basso ma già segnalato"
  echo "540.0 10.0" > "$OPS_PROC_UPTIME"
  watch $((T0 + 4200)) >/dev/null
  assert_eq "$(msgs)" 1
}
test_prima_esecuzione_non_segnala_riavvio() {
  setup; echo "60.0 1.0" > "$OPS_PROC_UPTIME"
  watch $T0 >/dev/null
  assert_eq "$(msgs)" 0 "senza esecuzione precedente non c'è nulla da confrontare"
}
test_esito_job_fallito_senza_doppioni() {
  setup
  echo corrupt > "$STUB_DIR/dump_mode"
  "$OPS_REAL/backup.sh" >/dev/null 2>&1 || true
  assert_eq "$(msgs)" 1 "il job ha già avvisato"
  watch $T0 >/dev/null
  assert_eq "$(msgs)" 1 "watch.sh non ripete lo stesso avviso"
  assert_contains "$(cat "$SB/out")" "ultimo esito di backup fallito"
  # un job che non è riuscito ad avvisare (Telegram giù) viene segnalato da watch
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write update fail "git pull non riuscito" ) >/dev/null 2>&1
  watch $((T0 + 300)) >/dev/null
  assert_eq "$(msgs)" 2
  assert_contains "$(last_msg)" "git pull non riuscito"
  watch $((T0 + 600)) >/dev/null
  assert_eq "$(msgs)" 2 "una sola volta per esito"
}
test_ping_esterno_a_ogni_esecuzione_anche_con_problemi() {
  setup; printf 'HC_PING_URL_WATCH=https://hc.example/watch-uuid\n' >> "$HOME_DIR/ops.env"
  watch $T0 >/dev/null
  echo unhealthy > "$STUB_DIR/inspect.out.web"
  watch $((T0 + 300)) >/dev/null
  assert_eq "$(grep -c 'watch-uuid' "$CURL_STDIN")" 2
  assert_not_contains "$(cat "$CURL_ARGS")" "watch-uuid"
}
test_esecuzione_in_corso_viene_saltata() {
  setup
  cat > "$SB/holder.sh" <<EOF2
#!/usr/bin/env bash
OPS_DIR="$OPS_REAL"
. "$OPS_REAL/lib.sh"
detect_layout
JOB_NAME=holder; trap job_on_exit EXIT
lock_acquire watch
echo locked
sleep 5
EOF2
  bash "$SB/holder.sh" > "$SB/holder.out" 2>&1 &
  hp=$!
  for _ in $(seq 1 20); do grep -q locked "$SB/holder.out" 2>/dev/null && break; sleep 0.2; done
  assert_eq "$(watch $T0)" 0
  assert_contains "$(cat "$SB/out")" "salto"
  assert_no_file "$HOME_DIR/ops-state/watch.json" "lo stato non viene toccato"
  pkill -P "$hp" 2>/dev/null; kill "$hp" 2>/dev/null; wait "$hp" 2>/dev/null || true
}
test_simulate_fault_passa_dalla_macchina_a_stati() {
  setup
  watch $T0 >/dev/null; before="$(cat "$HOME_DIR/ops-state/watch.json")"
  OPS_NOW=$T0 "$OPS_REAL/watch.sh" --simulate-fault >"$SB/out" 2>&1; rc=$?
  assert_rc "$rc" 0
  assert_eq "$(msgs)" 3 "avviso, promemoria, ripristinato"
  assert_contains "$(cat "$CURL_STDIN")" "SIMULAZIONE di guasto"
  assert_contains "$(cat "$CURL_STDIN")" "Promemoria"
  assert_contains "$(cat "$CURL_STDIN")" "Ripristinato"
  assert_eq "$(cat "$HOME_DIR/ops-state/watch.json")" "$before" "lo stato reale non è toccato"
  assert_no_file "$HOME_DIR/ops-state/watch-sim.json"
  assert_not_contains "$(dc_log)" "stop" "nessun servizio fermato"
}
test_telegram_non_configurato_non_rompe() {
  setup; rm "$HOME_DIR/ops.env"; echo unhealthy > "$STUB_DIR/inspect.out.web"
  assert_eq "$(watch $T0)" 1; assert_eq "$(watch $((T0 + 300)))" 1
  assert_contains "$(cat "$SB/out")" "ERRORE"
}

run_tests
