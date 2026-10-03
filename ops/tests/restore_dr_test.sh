#!/usr/bin/env bash
# Test di ops/restore.sh e ops/dr.sh (stub di docker compose, repository git temporaneo).
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

export HEALTH_TRIES=3 HEALTH_SLEEP=0 DB_TRIES=3 DB_SLEEP=0

mk_backup() { # nome [righe-users]
  mkdir -p "$HOME_DIR/backups/$1"
  printf '{\n  "app": "soldi",\n  "label": "auto",\n  "createdAt": "2026-10-01T03:00:00.000Z",\n  "tables": {\n    "users": { "rows": %s },\n    "transactions": { "rows": 10 }\n  }\n}\n' "${2:-2}" > "$HOME_DIR/backups/$1/manifest.json"
}
setup() {
  make_deploy; make_stack; make_curl_stub "$SB/cbin"
  printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
  mk_backup soldi-backup-2026-10-01_03-00-00-000
  mk_backup soldi-backup-2026-09-24_03-00-00-000 3
}
rest() { printf '%s\n' "${CONFIRM:-RIPRISTINA}" | "$OPS_REAL/restore.sh" "$@" >"$SB/out" 2>&1; echo $?; }
pos() { dc_log | grep -n -- "$1" | head -n 1 | cut -d: -f1; }

# ------------------------------------------------------------------ restore.sh
test_restore_sequenza_corretta() {
  setup
  assert_eq "$(rest --latest)" 0
  assert_contains "$(cat "$SB/out")" "2026-10-01T03:00:00.000Z"
  assert_contains "$(cat "$SB/out")" "users"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/pre-restore-*.sql.gz)" 1 "dump di sicurezza"
  log="$(dc_log)"
  assert_contains "$log" "stop web"
  assert_contains "$log" "run --rm --no-deps -T web node src/backup/restore.js /app/backups/soldi-backup-2026-10-01_03-00-00-000 --yes"
  assert_contains "$log" "up -d web"
  # ordine: dump → stop → restore → up
  assert_eq "$(pos 'pg_dump')" "$(printf '%s\n' "$(pos 'pg_dump')" "$(pos 'stop web')" | sort -n | head -n 1)"
  assert_eq "$(printf '%s\n%s\n%s\n' "$(pos 'pg_dump')" "$(pos 'stop web')" "$(pos 'restore.js')" | sort -n | tr '\n' ' ')" "$(printf '%s\n%s\n%s\n' "$(pos 'pg_dump')" "$(pos 'stop web')" "$(pos 'restore.js')" | tr '\n' ' ')" "pg_dump < stop < restore"
  assert_contains "$(cat "$HOME_DIR/ops-state/restore.json")" '"ok":true'
}
test_restore_conferma_sbagliata_non_tocca_nulla() {
  setup
  assert_eq "$(CONFIRM=si rest --latest)" 1
  assert_contains "$(cat "$SB/out")" "Annullato"
  assert_not_contains "$(dc_log)" "pg_dump"
  assert_not_contains "$(dc_log)" "stop web"
  assert_eq "$(CONFIRM=ripristina rest --latest)" 1 "la parola va digitata esattamente"
}
test_restore_yes_solo_con_source() {
  setup
  assert_eq "$(rest --yes --latest)" 1
  assert_contains "$(cat "$SB/out")" "--yes si usa solo insieme a --source"
  assert_not_contains "$(dc_log)" "restore.js"
  assert_eq "$(rest --yes --source soldi-backup-2026-09-24_03-00-00-000 </dev/null)" 0
  assert_contains "$(dc_log)" "restore.js /app/backups/soldi-backup-2026-09-24_03-00-00-000"
}
test_restore_source_fuori_da_backups_o_inesistente() {
  setup; mkdir -p "$SB/altrove/soldi-backup-x"; mk_backup soldi-backup-ok
  assert_eq "$(rest --source "$SB/altrove/soldi-backup-x")" 1; assert_contains "$(cat "$SB/out")" "deve stare dentro"
  assert_eq "$(rest --source non-esiste)" 1; assert_contains "$(cat "$SB/out")" "non trovato"
  assert_not_contains "$(dc_log)" "restore.js"
}
test_restore_rifiuta_backup_personali() {
  setup; mkdir -p "$HOME_DIR/backups/soldi-user-backup-1-a-2026-10-01_03-00-00-000"
  assert_eq "$(rest --source soldi-user-backup-1-a-2026-10-01_03-00-00-000)" 1
  assert_contains "$(cat "$SB/out")" "backup personale"
}
test_restore_dump_di_sicurezza_fallito_non_modifica() {
  setup; echo corrupt > "$STUB_DIR/dump_mode"
  assert_eq "$(rest --latest)" 1
  assert_contains "$(cat "$SB/out")" "NON modifico nulla"
  assert_not_contains "$(dc_log)" "stop web"
  assert_not_contains "$(dc_log)" "restore.js"
}
test_restore_fallito_stampa_il_comando_di_ritorno() {
  setup; echo 1 > "$STUB_DIR/restore_rc"
  assert_eq "$(rest --latest)" 1
  out="$(cat "$SB/out")"
  assert_contains "$out" "Ripristino NON riuscito"
  assert_contains "$out" "gzip -dc \"$HOME_DIR/backups/dumps/pre-restore-"
  assert_contains "$out" "exec -T db psql -v ON_ERROR_STOP=1 -U soldi_u -d soldi_db" "comando esatto con utente e database del .env"
  assert_contains "$(dc_log)" "up -d web" "web viene riavviato (i dati sono intatti: transazione)"
  assert_contains "$(cat "$HOME_DIR/ops-state/restore.json")" '"ok":false'
}
test_restore_web_non_sano_dopo_il_ripristino() {
  setup; echo unhealthy > "$STUB_DIR/inspect.out"
  assert_eq "$(rest --latest)" 1
  assert_contains "$(cat "$SB/out")" "non è tornato in salute"
  assert_contains "$(cat "$SB/out")" "pre-restore-"
}
test_restore_diag() {
  setup; echo 0 > "$STUB_DIR/diag_present"
  assert_eq "$(rest --latest)" 0
  assert_contains "$(dc_log)" "exec -T web npm run diag --silent"
  echo 1 > "$STUB_DIR/diag_rc"
  assert_eq "$(rest --latest)" 1; assert_contains "$(cat "$SB/out")" "ERRORI nei dati ripristinati"
}

# ------------------------------------------------------------------ dr.sh
dr_setup() {
  setup
  # origine git locale al posto di GitHub
  origin="$SB/origin.git"; work="$SB/work"
  git init -q --bare "$origin"; git -C "$origin" symbolic-ref HEAD refs/heads/main
  git init -q "$work"; git -C "$work" config user.email t@t; git -C "$work" config user.name t
  git -C "$work" checkout -q -b main 2>/dev/null || true
  echo x > "$work/f"; echo "services: {}" > "$work/docker-compose.yml"; printf 'JWT_SECRET=change-me\nSECRETS_KEY=\nPGPASSWORD=soldi\nPGUSER=soldi\n' > "$work/.env.example"
  git -C "$work" add -A; git -C "$work" commit -q -m c1; git -C "$work" push -q "$origin" main
  # sorgente: una cartella con backups/ e .env
  SRC="$SB/sorgente"; mkdir -p "$SRC/backups"
  cp -R "$HOME_DIR/backups/soldi-backup-2026-10-01_03-00-00-000" "$SRC/backups/"
  printf 'JWT_SECRET=originale\nSECRETS_KEY=%s\nPGUSER=soldi\nPGDATABASE=soldi\nPGPASSWORD=vecchia\n' "$(printf 'a%.0s' $(seq 1 64))" > "$SRC/.env"
  # destinazione: cartella nuova e vuota
  NEW="$SB/nuova"; mkdir -p "$NEW"
}
dr() { printf '%s\n' "${CONFIRM:-RIPRISTINA}" | "$OPS_REAL/dr.sh" --home "$NEW" --repo-url "$origin" "$@" >"$SB/out" 2>&1; echo $?; }

test_dr_dry_run_non_tocca_nulla() {
  dr_setup
  assert_eq "$(dr --source-dir "$SRC" --dry-run)" 0
  out="$(cat "$SB/out")"
  assert_contains "$out" "[dry-run]"
  assert_contains "$out" "up -d db"
  assert_contains "$out" "restore.js"
  assert_no_file "$NEW/.env"; assert_no_file "$NEW/app"
  assert_eq "$(count_files "$NEW"/backups/*)" 0
  assert_not_contains "$(dc_log)" "up -d" "nessun comando eseguito"
}
test_dr_completo_da_cartella() {
  dr_setup
  assert_eq "$(dr --source-dir "$SRC")" 0
  assert_file "$NEW/app/.git" "repository clonato in app/"
  assert_eq "$(grep '^JWT_SECRET=' "$NEW/.env")" "JWT_SECRET=originale" ".env originale ripristinato"
  assert_eq "$(stat -f %Lp "$NEW/.env" 2>/dev/null || stat -c %a "$NEW/.env")" 600
  assert_file "$NEW/backups/soldi-backup-2026-10-01_03-00-00-000/manifest.json"
  assert_file "$NEW/docker-compose.yml"
  log="$(dc_log)"
  assert_contains "$log" "up -d db"
  assert_contains "$log" "run --rm --no-deps -T web node src/db/migrate.js"
  assert_contains "$log" "run --rm --no-deps -T web node src/backup/restore.js /app/backups/soldi-backup-2026-10-01_03-00-00-000 --yes"
  assert_contains "$log" "up -d --build web"
  assert_eq "$(printf '%s\n%s\n%s\n' "$(pos 'up -d db')" "$(pos 'migrate.js')" "$(pos 'restore.js')" | sort -n | tr '\n' ' ')" "$(printf '%s\n%s\n%s\n' "$(pos 'up -d db')" "$(pos 'migrate.js')" "$(pos 'restore.js')" | tr '\n' ' ')" "db → migrate → restore"
  assert_contains "$(cat "$NEW/ops-state/dr.json")" '"ok":true'
}
test_dr_conferma_obbligatoria() {
  dr_setup
  assert_eq "$(CONFIRM=no dr --source-dir "$SRC")" 1
  assert_no_file "$NEW/.env"
  assert_not_contains "$(dc_log)" "up -d"
}
test_dr_env_di_un_backup_con_secrets_key_diversa_avvisa() {
  dr_setup
  printf 'SECRETS_KEY=%s\nJWT_SECRET=nuovo\n' "$(printf 'b%.0s' $(seq 1 64))" > "$NEW/.env"
  assert_eq "$(dr --source-dir "$SRC")" 0
  assert_eq "$(grep '^SECRETS_KEY=' "$NEW/.env")" "SECRETS_KEY=$(printf 'a%.0s' $(seq 1 64))" "vince quello originale"
  n=0; for f in "$NEW"/.env.pre-dr-*; do [ -f "$f" ] && n=$((n + 1)); done
  assert_eq "$n" 1 "copia di sicurezza del .env che c'era"
}
test_dr_senza_env_nella_sorgente_non_interattivo() {
  dr_setup; rm "$SRC/.env"
  assert_eq "$(dr --source-dir "$SRC")" 1
  assert_contains "$(cat "$SB/out")" "SECRETS_KEY"
}
test_dr_senza_env_guida_l_utente() {
  dr_setup; rm "$SRC/.env"
  key="$(printf 'c%.0s' $(seq 1 64))"
  out_rc="$(printf 'RIPRISTINA\noriginale-jwt\n%s\n' "$key" | "$OPS_REAL/dr.sh" --home "$NEW" --repo-url "$origin" --source-dir "$SRC" --ask-secrets >"$SB/out" 2>&1; echo $?)"
  assert_eq "$out_rc" 0
  assert_eq "$(grep '^JWT_SECRET=' "$NEW/.env")" "JWT_SECRET=originale-jwt"
  assert_eq "$(grep '^SECRETS_KEY=' "$NEW/.env")" "SECRETS_KEY=$key"
  assert_contains "$(cat "$SB/out")" "illeggibili"
}
test_dr_crea_proxy_net_se_serve() {
  dr_setup
  printf 'networks:\n  proxy-net:\n    external: true\n' > "$NEW/docker-compose.yml"
  assert_eq "$(dr --source-dir "$SRC")" 0
  assert_contains "$(docker_log)" "network create proxy-net"
}
test_dr_da_restic() {
  dr_setup
  printf 'RESTIC_REPOSITORY=sftp:u@h:/x\nRESTIC_PASSWORD_FILE=%s/pw\n' "$SB" > "$NEW/ops.env"; printf pw > "$SB/pw"; chmod 600 "$SB/pw"
  make_stub "$SB/bin/restic" '
echo "$*" >> "$STUB_DIR/restic.log"
if [ "$1" = restore ]; then
  tgt=""; while [ $# -gt 0 ]; do [ "$1" = --target ] && tgt="$2"; shift; done
  mkdir -p "$tgt/srv/soldi/backups"; cp -R "'"$SRC"'/backups/." "$tgt/srv/soldi/backups/"; cp "'"$SRC"'/.env" "$tgt/srv/soldi/.env"
fi'
  assert_eq "$(dr --restic)" 0
  assert_contains "$(restic_log)" "restore latest --tag soldi --target"
  assert_eq "$(grep '^JWT_SECRET=' "$NEW/.env")" "JWT_SECRET=originale"
  assert_contains "$(dc_log)" "restore.js /app/backups/soldi-backup-2026-10-01_03-00-00-000"
}
test_dr_restore_fallito() {
  dr_setup; echo 1 > "$STUB_DIR/restore_rc"
  assert_eq "$(dr --source-dir "$SRC")" 1
  assert_contains "$(cat "$SB/out")" "Ripristino NON riuscito"
  assert_not_contains "$(dc_log)" "up -d --build web" "web non si avvia su dati non ripristinati"
}

run_tests
