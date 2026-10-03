#!/usr/bin/env bash
# Test di ops/setup.sh, ops/cron.sh, ops/cronrun.sh, ops/status.sh e dei comandi diag/user di soldi.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

export HEALTH_TRIES=2 HEALTH_SLEEP=0
REPO_ROOT="$(cd "$OPS_REAL/.." && pwd)"

# Cartella di progetto "repo" senza .env, con i modelli veri e i due compose
setup_proj() {
  new_sandbox; HOME_DIR="$SB/proj"; mkdir -p "$HOME_DIR/backups"
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/ops.env.example" "$HOME_DIR/"
  cp "$REPO_ROOT/docker-compose.yml" "$REPO_ROOT/docker-compose.npm.yml" "$HOME_DIR/"
  git -C "$HOME_DIR" init -q
  make_stack
  export SOLDI_HOME="$HOME_DIR"
}
setup() { "$OPS_REAL/setup.sh" --home "$HOME_DIR" --skip-user "$@" >"$SB/out" 2>&1; echo $?; }
envv() { ( . "$OPS_REAL/lib.sh" >/dev/null 2>&1; read_kv "$HOME_DIR/.env" "$1" ); }

# ------------------------------------------------------------------ setup.sh
test_setup_scenario_1_lan() {
  setup_proj
  assert_eq "$(setup --scenario 1 --tz Europe/Rome --yes)" 0
  assert_eq "$(envv HTTPS_ENABLED)" false; assert_eq "$(envv COOKIE_SECURE)" false
  assert_eq "$(envv ALLOW_REGISTRATION)" false
  assert_eq "$(envv BIND_ADDR)" 0.0.0.0; assert_eq "$(envv HOST_PORT)" 3000
  assert_eq "$(envv TZ)" Europe/Rome
  assert_eq "$(fmode "$HOME_DIR/.env")" 600
  assert_eq "$(envv JWT_SECRET | wc -c | tr -d ' ')" 65 "64 esadecimali + a capo"
  case "$(envv SECRETS_KEY)" in *[!0-9a-f]*|'') _fail "SECRETS_KEY non è esadecimale" ;; *) _pass ;; esac
  assert_eq "$(envv SECRETS_KEY | tr -d '\n' | wc -c | tr -d ' ')" 64 "formato di src/crypto/secrets.js (openssl rand -hex 32)"
  assert_ne "$(envv PGPASSWORD)" soldi "PGPASSWORD casuale"
  assert_contains "$(dc_log)" "up -d --build"
}
test_setup_scenari_proxy() {
  setup_proj
  assert_eq "$(setup --scenario 2 --yes)" 0
  assert_eq "$(envv BIND_ADDR)" 127.0.0.1; assert_eq "$(envv HOST_PORT)" 3010; assert_eq "$(envv HTTPS_ENABLED)" true; assert_eq "$(envv COOKIE_SECURE)" true; assert_eq "$(envv TRUST_PROXY)" 1
  setup_proj
  assert_eq "$(setup --scenario 4 --yes)" 0
  assert_eq "$(envv BIND_ADDR)" 0.0.0.0; assert_eq "$(envv HOST_PORT)" 3010; assert_eq "$(envv HTTPS_ENABLED)" true
  setup_proj
  assert_eq "$(setup --scenario 3 --yes)" 0
  assert_eq "$(envv COMPOSE_FILE)" docker-compose.npm.yml
  assert_eq "$(envv PUID)" "$(id -u)"
  assert_ne "$(envv PGID)" ""
  assert_eq "$(envv HTTPS_ENABLED)" true; assert_eq "$(envv TRUST_PROXY)" 1
  assert_contains "$(docker_log)" "network create proxy-net" "il compose npm usa la rete esterna proxy-net"
}
test_setup_scenario_non_valido_e_prerequisiti() {
  setup_proj
  assert_eq "$(setup --scenario 9 --yes)" 1; assert_contains "$(cat "$SB/out")" "Scenario non valido"
  assert_no_file "$HOME_DIR/.env"
  out="$(PATH="/usr/bin:/bin" DOCKER=/non/esiste DC="" "$OPS_REAL/setup.sh" --home "$HOME_DIR" --scenario 1 --yes 2>&1)"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "Prerequisiti mancanti"
}
test_setup_non_sovrascrive_un_env_esistente_senza_conferma() {
  setup_proj
  printf 'JWT_SECRET=originale-lungo-e-bello-0123456789\nSECRETS_KEY=%s\nPGPASSWORD=vecchiapw\nALTRO=boh\n' "$(printf 'd%.0s' $(seq 1 64))" > "$HOME_DIR/.env"
  before="$(cat "$HOME_DIR/.env")"
  assert_eq "$(setup --scenario 1 --yes)" 1 "con --yes (o senza terminale) la risposta predefinita è NO"
  assert_contains "$(cat "$SB/out")" "Annullato"
  assert_eq "$(cat "$HOME_DIR/.env")" "$before" ".env intatto"
  # con conferma: copia di sicurezza e segreti mantenuti
  out_rc="$(printf 's\n' | SETUP_STDIN=1 "$OPS_REAL/setup.sh" --home "$HOME_DIR" --scenario 1 --tz Europe/Rome --skip-user --no-start >"$SB/out" 2>&1; echo $?)"
  assert_eq "$out_rc" 0
  n=0; for f in "$HOME_DIR"/.env.bak-*; do [ -f "$f" ] && n=$((n + 1)); done; assert_eq "$n" 1 "copia di sicurezza"
  assert_eq "$(fmode "$(ls "$HOME_DIR"/.env.bak-* | head -n 1)")" 600
  assert_eq "$(envv JWT_SECRET)" "originale-lungo-e-bello-0123456789" "i segreti già presenti si mantengono"
  assert_eq "$(envv SECRETS_KEY)" "$(printf 'd%.0s' $(seq 1 64))"
  assert_eq "$(envv PGPASSWORD)" vecchiapw
}
test_setup_volume_db_esistente_non_rigenera_pgpassword() {
  setup_proj
  make_stub "$SB/bin/docker" '
echo "$*" >> "$STUB_DIR/docker.log"
case "$*" in
  "volume ls"*) echo proj_db-data ;;
  "compose version") exit 0 ;;
  inspect*) echo healthy ;;
  *) exit 0 ;;
esac'
  # nessun .env: rifiuta (non può inventare la password)
  assert_eq "$(setup --scenario 1 --yes)" 1
  assert_contains "$(cat "$SB/out")" "POSTGRES_PASSWORD vale solo alla prima inizializzazione"
  assert_no_file "$HOME_DIR/.env"
  # con un .env esistente: PGPASSWORD mantenuta anche se è quella predefinita
  printf 'JWT_SECRET=x\nPGPASSWORD=soldi\n' > "$HOME_DIR/.env"
  out_rc="$(printf 's\n' | SETUP_STDIN=1 "$OPS_REAL/setup.sh" --home "$HOME_DIR" --scenario 1 --tz Europe/Rome --skip-user --no-start >"$SB/out" 2>&1; echo $?)"
  assert_eq "$out_rc" 0
  assert_eq "$(envv PGPASSWORD)" soldi "il volume è inizializzato con quella password"
  assert_contains "$(cat "$SB/out")" "PGPASSWORD mantenuta"
  # interattivo: la password originale si inserisce a mano
  rm "$HOME_DIR/.env"
  out_rc="$(printf 'passwordoriginale\n' | SETUP_STDIN=1 "$OPS_REAL/setup.sh" --home "$HOME_DIR" --scenario 1 --tz Europe/Rome --skip-user --no-start >"$SB/out" 2>&1; echo $?)"
  assert_eq "$out_rc" 0; assert_eq "$(envv PGPASSWORD)" passwordoriginale
}
test_setup_no_start_e_ops_env() {
  setup_proj
  assert_eq "$(setup --scenario 1 --yes --no-start)" 0
  assert_not_contains "$(dc_log)" "up -d"
  rm -f "$HOME_DIR/.env"
  out_rc="$(printf 'tok:EN\n42\nsftp:u@h:/x\n' | SETUP_STDIN=1 HOME="$SB" "$OPS_REAL/setup.sh" --home "$HOME_DIR" --scenario 1 --tz Europe/Rome --skip-user --no-start --ops-env >"$SB/out" 2>&1; echo $?)"
  assert_eq "$out_rc" 0
  assert_eq "$(fmode "$HOME_DIR/ops.env")" 600
  assert_eq "$( ( . "$OPS_REAL/lib.sh" >/dev/null 2>&1; read_kv "$HOME_DIR/ops.env" ALERT_TG_CHAT ) )" 42
  assert_eq "$( ( . "$OPS_REAL/lib.sh" >/dev/null 2>&1; read_kv "$HOME_DIR/ops.env" RESTIC_REPOSITORY ) )" "sftp:u@h:/x"
  assert_eq "$(fmode "$SB/.restic-soldi-password")" 600 "password di restic generata, 600"
  assert_contains "$(cat "$SB/out")" "CONSERVALA anche altrove"
}

# ------------------------------------------------------------------ cron
mk_fake_crontab() { # file-di-stato
  make_stub "$SB/bin/crontab" 'f="'"$1"'"; if [ "${1:-}" = -l ]; then [ -f "$f" ] && cat "$f" || { echo "no crontab for user" >&2; exit 1; }; else cat > "$f"; fi'
  export CRONTAB="$SB/bin/crontab"
}
test_cron_print_install_remove_idempotente() {
  make_deploy; make_stack; mk_fake_crontab "$SB/crontab.txt"
  printf '# altro job\n0 1 * * * /usr/bin/altro\n' > "$SB/crontab.txt"
  out="$("$OPS_REAL/cron.sh" print)"
  assert_contains "$out" "# BEGIN soldi"; assert_contains "$out" "# END soldi"
  assert_contains "$out" "*/5 * * * * SOLDI_HOME='$HOME_DIR'"
  assert_contains "$out" "30 2 * * * "; assert_contains "$out" "0 8 * * * "
  assert_contains "$out" "cronrun.sh watch -- $OPS_REAL/watch.sh"
  assert_contains "$out" "cronrun.sh backup -- $OPS_REAL/backup.sh"
  assert_contains "$out" "cronrun.sh backup-check -- $OPS_REAL/backup-check.sh"
  assert_contains "$out" '0 5 * * 0 [ "$(date +\%d)" -le 7 ] &&' "primo domenica del mese (cron unisce giorno e settimana con OR)"
  assert_not_contains "$out" "--from-offsite" "restic non configurato"
  "$OPS_REAL/cron.sh" install >/dev/null 2>&1; "$OPS_REAL/cron.sh" install >/dev/null 2>&1
  assert_eq "$(grep -c '# BEGIN soldi' "$SB/crontab.txt")" 1 "idempotente"
  assert_eq "$(grep -c '^\*/5' "$SB/crontab.txt")" 1
  assert_contains "$(cat "$SB/crontab.txt")" "/usr/bin/altro" "gli altri job restano"
  "$OPS_REAL/cron.sh" remove >/dev/null 2>&1
  assert_not_contains "$(cat "$SB/crontab.txt")" "soldi"
  assert_contains "$(cat "$SB/crontab.txt")" "/usr/bin/altro"
}
test_cron_from_offsite_se_restic_configurato() {
  make_deploy; make_stack; mk_fake_crontab "$SB/crontab.txt"
  printf 'RESTIC_REPOSITORY=sftp:u@h:/x\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" > "$HOME_DIR/ops.env"
  assert_contains "$("$OPS_REAL/cron.sh" print)" "restore-test.sh --from-offsite"
}
test_cron_rifiuta_percorsi_con_apice() {
  make_deploy; make_stack; mk_fake_crontab "$SB/crontab.txt"
  mkdir "$SB/it's"; cp -R "$HOME_DIR/." "$SB/it's/"
  out="$(SOLDI_HOME="$SB/it's" "$OPS_REAL/cron.sh" print 2>&1)"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "apice"
}
test_cronrun_log_lock_e_rotazione() {
  make_deploy
  "$OPS_REAL/cronrun.sh" prova -- bash -c 'echo uno; echo errore >&2; exit 3' ; rc=$?
  assert_rc "$rc" 3 "restituisce il codice del comando"
  log="$HOME_DIR/ops-state/prova.log"
  assert_contains "$(cat "$log")" "uno"; assert_contains "$(cat "$log")" "errore"; assert_contains "$(cat "$log")" "fine (codice 3)"
  # rotazione oltre il limite
  CRON_LOG_MAX_BYTES=10 "$OPS_REAL/cronrun.sh" prova -- echo due
  assert_file "$log.1"; assert_contains "$(cat "$log")" "due"
  CRON_LOG_MAX_BYTES=10 "$OPS_REAL/cronrun.sh" prova -- echo tre
  CRON_LOG_MAX_BYTES=10 "$OPS_REAL/cronrun.sh" prova -- echo quattro
  assert_file "$log.2"; assert_no_file "$log.3" "al massimo 3 file"
  [ "$(fmode "$log")" = 600 ] && _pass || _fail "permessi del log"
}
test_cronrun_esemplare_unico() {
  make_deploy
  "$OPS_REAL/cronrun.sh" lento -- bash -c 'sleep 3' &
  hp=$!
  for _ in $(seq 1 20); do [ -f "$HOME_DIR/ops-state/lento.log" ] && break; sleep 0.2; done; sleep 0.3
  "$OPS_REAL/cronrun.sh" lento -- echo non-deve-girare; rc=$?
  assert_rc "$rc" 0
  assert_contains "$(cat "$HOME_DIR/ops-state/lento.log")" "già in corso, salto"
  assert_not_contains "$(cat "$HOME_DIR/ops-state/lento.log")" "non-deve-girare"
  pkill -P "$hp" 2>/dev/null; kill "$hp" 2>/dev/null; wait "$hp" 2>/dev/null || true
}

# ------------------------------------------------------------------ status
# shellcheck disable=SC2120
st() { "$OPS_REAL/status.sh" "$@" 2>&1; }
test_status_completo_e_avvisi() {
  make_deploy; make_stack; make_curl_stub "$SB/cbin"; echo 0 > "$STUB_DIR/diag_present"
  out="$(st)"; rc=$?
  assert_rc "$rc" 2 "mancano backup e copia fuori macchina → avvisi"
  assert_contains "$out" "Soldi — stato (deploy: $HOME_DIR)"
  assert_contains "$out" "web: healthy · db: healthy"
  assert_contains "$out" "applicativo: MAI"
  assert_contains "$out" "fuori macchina: NON configurata"
  assert_contains "$out" "prova di ripristino: mai eseguita"
  assert_contains "$out" "20 ok, 0 avvisi, 0 errori"
  assert_contains "$out" "nessun backup applicativo: soldi backup"
  "$OPS_REAL/backup.sh" >/dev/null 2>&1
  printf 'RESTIC_REPOSITORY=sftp:u@h:/x\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" > "$HOME_DIR/ops.env"; printf pw > "$SB/pw"; chmod 600 "$SB/pw"
  "$OPS_REAL/offsite.sh" >/dev/null 2>&1
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write restore-test ok "ok" ) >/dev/null 2>&1
  out="$(st)"; rc=$?
  assert_rc "$rc" 0 "tutto a posto"
  assert_contains "$out" "applicativo: soldi-backup-"; assert_contains "$out" "dump:        soldi-"
  assert_contains "$out" "ultima copia"; assert_contains "$out" "prova di ripristino: riuscita"
  assert_contains "$out" "nessuno"
}
test_status_problemi() {
  make_deploy; make_stack
  echo unhealthy > "$STUB_DIR/inspect.out.web"
  echo '{"summary":{"ok":18,"warn":1,"error":2}}' > "$STUB_DIR/diag_json"; echo 0 > "$STUB_DIR/diag_present"
  out="$(st)"
  assert_contains "$out" "il container web non è in salute (unhealthy)"
  assert_contains "$out" "la diagnostica ha 2 ERRORI"
  assert_contains "$out" "la diagnostica ha 1 avvisi"
  ( . "$OPS_REAL/lib.sh"; detect_layout; state_write restore-test fail "x" ) >/dev/null 2>&1
  assert_contains "$(st)" "FALLITA"
}
test_status_diag_non_disponibile() {
  make_deploy; make_stack; echo 1 > "$STUB_DIR/diag_present"
  assert_contains "$(st)" "non disponibile nell'immagine"
}

# ------------------------------------------------------------------ comandi diag e user di soldi
test_soldi_diag_e_user() {
  make_deploy; make_stack
  echo 0 > "$STUB_DIR/diag_present"
  "$OPS_REAL/soldi" diag --json >/dev/null 2>&1; rc=$?
  assert_rc "$rc" 0
  assert_contains "$(dc_log)" "exec -T web npm run diag --silent -- --json"
  echo 1 > "$STUB_DIR/diag_present"
  out="$("$OPS_REAL/soldi" diag 2>&1)"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "serve la ricostruzione"
  "$OPS_REAL/soldi" user list >/dev/null 2>&1
  "$OPS_REAL/soldi" user create mario 'pw' >/dev/null 2>&1
  "$OPS_REAL/soldi" user manage >/dev/null 2>&1
  assert_contains "$(dc_log)" "exec -T web npm run user:list"
  assert_contains "$(dc_log)" "exec -T web npm run user:create -- mario pw"
  assert_contains "$(dc_log)" "exec -T web npm run user:manage"
  out="$("$OPS_REAL/soldi" user boh 2>&1)"; assert_contains "$out" "sottocomando sconosciuto"
}

run_tests
