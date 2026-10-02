#!/usr/bin/env bash
# Test di ops/backup.sh, ops/offsite.sh e ops/backup-check.sh (con stub, senza Docker reale).
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

setup() { make_deploy; make_stack; make_curl_stub "$SB/cbin"; }
backup() { "$OPS_REAL/backup.sh" >"$SB/out" 2>&1; echo $?; }

# ------------------------------------------------------------------ backup.sh
test_backup_ok() {
  setup
  assert_eq "$(backup)" 0
  dumps=("$HOME_DIR"/backups/dumps/soldi-*.sql.gz)
  assert_eq "${#dumps[@]}" 1
  assert_eq "$(stat -f %Lp "${dumps[0]}" 2>/dev/null || stat -c %a "${dumps[0]}")" 600 "dump 600"
  assert_eq "$(gzip -dc "${dumps[0]}" | tail -n 1)" "-- PostgreSQL database dump complete"
  assert_eq "$(count_files "$HOME_DIR"/backups/soldi-backup-*/manifest.json)" 1
  assert_contains "$(dc_log)" "exec -T web npm run backup"
  assert_contains "$(dc_log)" "exec -T db pg_dump -U soldi_u --clean --if-exists soldi_db" "usa PGUSER/PGDATABASE del .env (anche tra virgolette)"
  state="$(cat "$HOME_DIR/ops-state/backup.json")"
  assert_contains "$state" '"job":"backup","ok":true,"status":"ok"'
  assert_contains "$state" '"offsite":"skipped"'
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/*.tmp)" 0
  assert_eq "$(restic_log)" "" "restic non configurato: non viene chiamato"
}
test_backup_dump_corrotto_fallisce_e_rimuove_il_file() {
  setup; printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
  echo corrupt > "$STUB_DIR/dump_mode"
  assert_eq "$(backup)" 1
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/*)" 0 "nessun dump (né .tmp) rimasto"
  assert_contains "$(cat "$HOME_DIR/ops-state/backup.json")" '"ok":false'
  assert_contains "$(cat "$CURL_STDIN")" "dump PostgreSQL FALLITO" "notifica dell'errore"
  echo fail > "$STUB_DIR/dump_mode"
  assert_eq "$(backup)" 1 "pg_dump che fallisce a metà (pipefail)"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/*)" 0
}
test_backup_dump_non_gzip_o_vuoto() {
  setup
  make_stub "$SB/bin/dc" 'echo "$*" >> "$STUB_DIR/dc.log"; case "$*" in "ps --status running --services") printf "web\ndb\n";; "exec -T db pg_dump "*) ;; *) exit 0;; esac'
  assert_eq "$(backup)" 1 "dump vuoto"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/*)" 0
}
test_backup_retention_dump() {
  setup; mkdir -p "$HOME_DIR/backups/dumps"
  for i in $(seq 10 25); do f="$HOME_DIR/backups/dumps/soldi-202601$i-000000.sql.gz"; : > "$f"; touch -t "202601${i}0000" "$f"; done
  assert_eq "$(backup)" 0
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/soldi-*.sql.gz)" 14 "DUMP_KEEP predefinito 14"
  assert_no_file "$HOME_DIR/backups/dumps/soldi-20260110-000000.sql.gz" "il più vecchio è sparito"
  echo 'DUMP_KEEP=3' > "$HOME_DIR/ops.env"
  assert_eq "$(backup)" 0
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/soldi-*.sql.gz)" 3
}
test_backup_web_fermo_e_avviso() {
  setup; printf 'db\n' > "$STUB_DIR/running"
  assert_eq "$(backup)" 2 "solo db in esecuzione: dump sì, backup applicativo no → avviso"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/soldi-*.sql.gz)" 1
  assert_contains "$(cat "$HOME_DIR/ops-state/backup.json")" '"status":"warn"'
}
test_backup_db_fermo_errore() {
  setup; printf 'web\n' > "$STUB_DIR/running"
  assert_eq "$(backup)" 1
}
test_backup_backup_applicativo_fallito() {
  setup; touch "$STUB_DIR/fail_appbackup"
  assert_eq "$(backup)" 1
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/soldi-*.sql.gz)" 1 "il dump viene comunque fatto"
}
test_backup_lancia_offsite_se_configurato() {
  setup
  printf 'RESTIC_REPOSITORY=sftp:u@h:/x\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" > "$HOME_DIR/ops.env"; printf 'x' > "$SB/pw"; chmod 600 "$SB/pw"
  assert_eq "$(backup)" 0
  assert_contains "$(restic_log)" "backup --tag soldi"
  assert_contains "$(cat "$HOME_DIR/ops-state/backup.json")" '"offsite":"ok"'
  echo 1 > "$STUB_DIR/restic.rc.backup"
  assert_eq "$(backup)" 2 "locale ok, offsite fallita → avviso"
  assert_contains "$(cat "$HOME_DIR/ops-state/backup.json")" "copia fuori macchina FALLITA"
  assert_contains "$(cat "$HOME_DIR/ops-state/offsite.json")" '"ok":false'
}
test_backup_ping_hc_senza_url_negli_argomenti() {
  setup; printf 'HC_PING_URL=https://hc.example/uuid-segreto\nHC_PING_URL_OFFSITE=https://hc.example/offsite-uuid\n' > "$HOME_DIR/ops.env"
  assert_eq "$(backup)" 0
  assert_not_contains "$(cat "$CURL_ARGS")" "uuid-segreto"
  assert_contains "$(cat "$CURL_STDIN")" 'url = "https://hc.example/uuid-segreto/start"'
  assert_contains "$(cat "$CURL_STDIN")" 'url = "https://hc.example/uuid-segreto"'
  echo corrupt > "$STUB_DIR/dump_mode"; : > "$CURL_STDIN"
  backup >/dev/null
  assert_contains "$(cat "$CURL_STDIN")" 'url = "https://hc.example/uuid-segreto/fail"'
}
test_backup_lock() {
  setup
  mkdir "$HOME_DIR/.backup.lock.d"; echo $$ > "$HOME_DIR/.backup.lock.d/pid"
  if command -v flock >/dev/null 2>&1; then _pass; else assert_eq "$(backup)" 1 "lock già preso"; assert_contains "$(cat "$SB/out")" "già in corso"; fi
}

# ------------------------------------------------------------------ offsite.sh
offsite() { "$OPS_REAL/offsite.sh" "$@" >"$SB/out" 2>&1; echo $?; }
conf_restic() {
  printf 'RESTIC_REPOSITORY=sftp:utente:PASSWORD-SEGRETA@host:/srv\nRESTIC_PASSWORD_FILE=%s/pw\nAWS_ACCESS_KEY_ID=AKIA123\n' "$SB" > "$HOME_DIR/ops.env"
  printf 'pw' > "$SB/pw"; chmod 600 "$SB/pw"
}
test_offsite_non_configurato_avvisa() {
  setup
  assert_eq "$(offsite)" 2
  assert_contains "$(cat "$SB/out")" "macchina NON configurata"
  assert_contains "$(cat "$HOME_DIR/ops-state/offsite.json")" '"status":"warn"'
  assert_eq "$(restic_log)" ""
}
test_offsite_restic_assente() {
  setup; conf_restic
  assert_eq "$(RESTIC=/non/esiste "$OPS_REAL/offsite.sh" >"$SB/out" 2>&1; echo $?)" 2
  assert_contains "$(cat "$SB/out")" "restic non è installato"
}
test_offsite_backup_forget_check_e_cadenza_settimanale() {
  setup; conf_restic
  assert_eq "$(OPS_NOW=1700000000 offsite)" 0
  log1="$(restic_log)"
  assert_contains "$log1" "backup --tag soldi $HOME_DIR/backups $HOME_DIR/.env $HOME_DIR/docker-compose.yml" "salva backups/, .env e il compose di produzione"
  assert_contains "$log1" "forget --tag soldi --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune"
  assert_contains "$log1" "check --read-data-subset=5%"
  assert_contains "$log1" "pw=$SB/pw"
  assert_contains "$log1" "aws=AKIA123" "credenziali del backend esportate"
  assert_not_contains "$(cat "$SB/out")" "PASSWORD-SEGRETA" "l'URL con credenziali non va nei log"
  : > "$STUB_DIR/restic.log"
  assert_eq "$(OPS_NOW=1700086400 offsite)" 0
  log2="$(restic_log)"
  assert_not_contains "$log2" "--prune" "stesso giorno: niente prune"
  assert_not_contains "$log2" "check " "né check"
  : > "$STUB_DIR/restic.log"
  assert_eq "$(OPS_NOW=$((1700000000 + 7 * 86400)) offsite)" 0
  assert_contains "$(restic_log)" "--prune" "dopo 7 giorni: di nuovo"
  assert_contains "$(restic_log)" "check --read-data-subset=5%"
}
test_offsite_init_solo_se_richiesto() {
  setup; conf_restic
  echo 1 > "$STUB_DIR/restic.rc.cat"
  assert_eq "$(offsite)" 1 "senza --init e repository assente: errore"
  assert_contains "$(cat "$SB/out")" "--init"
  assert_not_contains "$(restic_log)" "init" "mai init in automatico"
  assert_eq "$(offsite --init)" 0
  assert_contains "$(restic_log)" "init |"
}
test_offsite_permessi_e_posizione_della_password() {
  setup; conf_restic
  chmod 644 "$SB/pw"
  assert_eq "$(offsite)" 1; assert_contains "$(cat "$SB/out")" "permessi troppo aperti"
  chmod 600 "$SB/pw"; cp "$SB/pw" "$HOME_DIR/app/pw"; chmod 600 "$HOME_DIR/app/pw"
  sed -i.bak "s#RESTIC_PASSWORD_FILE=.*#RESTIC_PASSWORD_FILE=$HOME_DIR/app/pw#" "$HOME_DIR/ops.env"
  assert_eq "$(offsite)" 1; assert_contains "$(cat "$SB/out")" "dentro il repository"
}
test_offsite_incompleto_e_check_fallito() {
  setup; conf_restic
  echo 3 > "$STUB_DIR/restic.rc.backup"
  assert_eq "$(offsite)" 2 "restic backup exit 3 = alcuni file illeggibili → avviso"
  echo 0 > "$STUB_DIR/restic.rc.backup"; echo 1 > "$STUB_DIR/restic.rc.check"; rm -f "$HOME_DIR/ops-state/offsite-check.stamp"
  assert_eq "$(offsite)" 1; assert_contains "$(cat "$SB/out")" "restic check"
  echo 1 > "$STUB_DIR/restic.rc.backup"
  assert_eq "$(offsite)" 1 "backup restic fallito"
}
test_offsite_layout_repo_non_salva_il_compose() {
  make_repo; make_stack; make_curl_stub "$SB/cbin"
  printf 'RESTIC_REPOSITORY=/tmp/repo-restic\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" > "$HOME_DIR/ops.env"; printf pw > "$SB/pw"; chmod 600 "$SB/pw"
  assert_eq "$(offsite)" 0
  assert_not_contains "$(restic_log)" "docker-compose.yml"
}

# ------------------------------------------------------------------ backup-check.sh
check() { "$OPS_REAL/backup-check.sh" >"$SB/out" 2>&1; echo $?; }
fresh_state() {
  setup; printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
  export DISK_MIN_FREE_PCT=0   # indipendente dal disco della macchina di test
  assert_eq "$(backup)" 0 "backup di partenza"
  : > "$CURL_STDIN"
  # prova di ripristino riuscita
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write restore-test ok "ok" ) >/dev/null 2>&1
  # restic configurato con uno snapshot di adesso
  printf 'RESTIC_REPOSITORY=/x\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" >> "$HOME_DIR/ops.env"; printf pw > "$SB/pw"; chmod 600 "$SB/pw"
  snap_at "$(date '+%Y-%m-%dT%H:%M:%S')"
}
snap_at() { printf '[{"time":"%s.123456+02:00","tags":["soldi"]}]\n' "$1" > "$STUB_DIR/restic.snapshots"; }
test_check_tutto_ok() {
  fresh_state
  assert_eq "$(check)" 0; assert_contains "$(cat "$SB/out")" "ultimo backup applicativo"
  assert_contains "$(cat "$HOME_DIR/ops-state/backup-check.json")" '"ok":true'
  assert_eq "$(sends=$(grep -c '^----$' "$CURL_STDIN" || true); echo "$sends")" 0 "nessuna notifica se va tutto bene"
}
test_check_backup_applicativo_vecchio_e_manifest() {
  fresh_state
  assert_eq "$(OPS_NOW=$(( $(date +%s) + 193 * 3600 )) check)" 1 "più di 192 ore → errore"
  assert_contains "$(cat "$SB/out")" "vecchio di 193 ore"
  rm -f "$HOME_DIR"/backups/soldi-backup-*/manifest.json
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "manifest.json mancante"
  for d in "$HOME_DIR"/backups/soldi-backup-*; do printf '{ "app": "soldi", "tables": { "users": { "rows": 0 } } }' > "$d/manifest.json"; done
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "nessun utente"
  for d in "$HOME_DIR"/backups/soldi-backup-*; do printf 'non json' > "$d/manifest.json"; done
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "non valido"
  rm -rf "$HOME_DIR"/backups/soldi-backup-*
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "nessun backup applicativo"
}
test_check_dump_vecchio_e_corrotto() {
  fresh_state
  assert_eq "$(OPS_NOW=$(( $(date +%s) + 31 * 3600 )) BACKUP_MAX_AGE_HOURS=999 check)" 1; assert_contains "$(cat "$SB/out")" "ultimo dump vecchio di 31 ore"
  assert_eq "$(OPS_NOW=$(( $(date +%s) + 29 * 3600 )) check)" 0 "29 ore: ok"
  for f in "$HOME_DIR"/backups/dumps/soldi-*.sql.gz; do printf 'SELECT 1;' | gzip > "$f"; done
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "dump corrotto"
}
test_check_restic() {
  fresh_state
  snap_at "$(date -v-40H '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -d '40 hours ago' '+%Y-%m-%dT%H:%M:%S')"
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "snapshot restic vecchio"
  echo 1 > "$STUB_DIR/restic.rc.snapshots"
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "non raggiungibile"
  echo 0 > "$STUB_DIR/restic.rc.snapshots"; echo '[]' > "$STUB_DIR/restic.snapshots"
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "nessuno snapshot"
  sed -i.bak '/RESTIC_/d' "$HOME_DIR/ops.env"
  assert_eq "$(check)" 2 "non configurata → avviso"; assert_contains "$(cat "$SB/out")" "NON configurata"
}
test_check_spazio_disco() {
  fresh_state
  assert_eq "$(DISK_MIN_FREE_PCT=101 check)" 2; assert_contains "$(cat "$SB/out")" "spazio libero"
}
test_check_prova_di_ripristino() {
  fresh_state
  rm "$HOME_DIR/ops-state/restore-test.json"
  assert_eq "$(check)" 2; assert_contains "$(cat "$SB/out")" "mai stata eseguita"
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write restore-test fail "rotta" ) >/dev/null 2>&1
  assert_eq "$(check)" 1; assert_contains "$(cat "$SB/out")" "FALLITA"
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write restore-test ok "ok" ) >/dev/null 2>&1
  assert_eq "$(OPS_NOW=$(( $(date +%s) + 41 * 86400 )) BACKUP_MAX_AGE_HOURS=99999 DUMP_MAX_AGE_HOURS=99999 OFFSITE_MAX_AGE_HOURS=99999 check)" 2
  assert_contains "$(cat "$SB/out")" "41 giorni fa"
}
test_check_notifiche_una_volta_ogni_24_ore_e_rientro() {
  fresh_state
  now="$(date +%s)"
  OPS_NOW=$((now + 200 * 3600)) BACKUP_MAX_AGE_HOURS=192 DUMP_MAX_AGE_HOURS=9999 OFFSITE_MAX_AGE_HOURS=9999 check >/dev/null
  assert_eq "$(grep -c '^----$' "$CURL_STDIN" || true)" 1 "primo errore: una notifica"
  OPS_NOW=$((now + 201 * 3600)) BACKUP_MAX_AGE_HOURS=192 DUMP_MAX_AGE_HOURS=9999 OFFSITE_MAX_AGE_HOURS=9999 check >/dev/null
  assert_eq "$(grep -c '^----$' "$CURL_STDIN" || true)" 1 "stesso problema entro 24 ore: nessun'altra"
  OPS_NOW=$((now + 230 * 3600)) BACKUP_MAX_AGE_HOURS=192 DUMP_MAX_AGE_HOURS=9999 OFFSITE_MAX_AGE_HOURS=9999 check >/dev/null
  assert_eq "$(grep -c '^----$' "$CURL_STDIN" || true)" 2 "dopo 24 ore: ripetuta"
  check >/dev/null
  assert_eq "$(grep -c '^----$' "$CURL_STDIN" || true)" 3 "rientro: messaggio"
  assert_contains "$(cat "$CURL_STDIN")" "rientrato"
}

run_tests
