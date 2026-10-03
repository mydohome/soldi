#!/usr/bin/env bash
# Test di ops/update.sh con stub di docker/compose e un repository git temporaneo (due commit).
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

export HEALTH_TRIES=3 HEALTH_SLEEP=0

# Origine con due commit; app/ clonata al primo (indietro di uno).
setup() {
  make_deploy
  origin="$SB/origin.git"; work="$SB/work"
  git init -q --bare "$origin"; git -C "$origin" symbolic-ref HEAD refs/heads/main
  git init -q "$work"; git -C "$work" config user.email t@t; git -C "$work" config user.name t
  git -C "$work" checkout -q -b main 2>/dev/null || true
  echo uno > "$work/file.txt"; git -C "$work" add -A; git -C "$work" commit -q -m c1
  C1="$(git -C "$work" rev-parse HEAD)"
  echo due > "$work/file.txt"; git -C "$work" commit -qam c2
  C2="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" push -q "$origin" main
  rm -rf "$HOME_DIR/app"; git clone -q "$origin" "$HOME_DIR/app"
  git -C "$HOME_DIR/app" reset -q --hard "$C1"
  make_stack; make_curl_stub "$SB/cbin"
  export STUB_APP="$HOME_DIR/app"
  printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
}
head_of() { git -C "$HOME_DIR/app" rev-parse HEAD; }
update() { "$OPS_REAL/update.sh" "$@" >"$SB/out" 2>&1; echo $?; }
deploys() { grep -c 'GIT_SHA=' "$STUB_DIR/dc.log" || true; }
sends() { grep -c '^----$' "$CURL_STDIN" || true; }

test_1_sano_exit_0_senza_rollback() {
  setup
  assert_eq "$(update)" 0
  assert_eq "$(head_of)" "$C2" "codice aggiornato"
  assert_eq "$(deploys)" 1 "un solo deploy"
  assert_contains "$(dc_log)" "up -d --build GIT_SHA=$C2" "GIT_SHA esportato per la build"
  assert_contains "$(dc_log)" "exec -T web npm run backup" "backup prima dell'aggiornamento"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/pre-update-*.sql.gz)" 1 "dump completo pre-aggiornamento"
  assert_contains "$(cat "$HOME_DIR/ops-state/update.json")" '"ok":true'
  assert_contains "$(cat "$CURL_STDIN")" "aggiornato" "notifica di successo"
  assert_eq "$(count_files "$HOME_DIR"/.update.lock.d)" 0 "lock rilasciato"
}
test_2_non_sano_rollback_e_exit_1() {
  setup
  echo "$C2" > "$STUB_DIR/bad_sha"
  assert_eq "$(update)" 1 "anche dopo un rollback riuscito l'aggiornamento risulta fallito"
  assert_eq "$(head_of)" "$C1" "git reset --hard al commit precedente"
  assert_eq "$(deploys)" 2 "secondo deploy dopo il rollback"
  assert_contains "$(cat "$SB/out")" "ripristinata la versione precedente"
  assert_contains "$(dc_log)" "logs --tail=40 web"
  assert_contains "$(cat "$HOME_DIR/ops-state/update.json")" '"ok":false'
  assert_contains "$(cat "$CURL_STDIN")" "ripristinata la versione precedente" "notifica del fallimento/rollback"
}
test_2b_rollback_fallito() {
  setup
  echo unhealthy > "$STUB_DIR/inspect.out"   # sano mai, nemmeno col codice vecchio
  assert_eq "$(update)" 1
  assert_contains "$(cat "$SB/out")" "rollback falliti"
  assert_contains "$(cat "$SB/out")" "pre-update-"
}
test_2c_nessun_codice_da_ripristinare() {
  setup
  git -C "$HOME_DIR/app" merge -q --ff-only origin/main 2>/dev/null || git -C "$HOME_DIR/app" fetch -q origin main && git -C "$HOME_DIR/app" reset -q --hard "$C2"
  echo unhealthy > "$STUB_DIR/inspect.out"
  assert_eq "$(update)" 1
  assert_contains "$(cat "$SB/out")" "nessun codice da ripristinare"
  assert_eq "$(deploys)" 1 "nessun secondo deploy"
}
test_3_backup_fallito_senza_force_non_fa_git_pull() {
  setup; touch "$STUB_DIR/fail_appbackup"
  assert_eq "$(update)" 1
  assert_eq "$(head_of)" "$C1" "nessun git pull eseguito"
  assert_eq "$(deploys)" 0 "nessun deploy"
  assert_contains "$(cat "$SB/out")" "--force"
  echo corrupt > "$STUB_DIR/dump_mode"; rm -f "$STUB_DIR/fail_appbackup"
  assert_eq "$(update)" 1 "anche un dump non valido blocca"
  assert_eq "$(head_of)" "$C1"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/pre-update-*)" 0 "file scartato"
}
test_3b_backup_fallito_con_force_procede() {
  setup; touch "$STUB_DIR/fail_appbackup"
  assert_eq "$(update --force)" 0
  assert_eq "$(head_of)" "$C2"
  assert_contains "$(cat "$SB/out")" "--force"
}
test_4_modifiche_locali_rifiutate() {
  setup
  echo sporco >> "$HOME_DIR/app/file.txt"
  assert_eq "$(update)" 1
  assert_contains "$(cat "$SB/out")" "Modifiche locali non committate"
  assert_eq "$(head_of)" "$C1"
  assert_not_contains "$(dc_log)" "npm run backup" "rifiuta prima di toccare qualsiasi cosa"
  git -C "$HOME_DIR/app" checkout -q -- file.txt
  echo staged >> "$HOME_DIR/app/file.txt"; git -C "$HOME_DIR/app" add file.txt
  assert_eq "$(update)" 1 "anche le modifiche in stage"
}
test_5_lock_gia_preso() {
  setup
  cat > "$SB/holder.sh" <<EOF2
#!/usr/bin/env bash
OPS_DIR="$OPS_REAL"
. "$OPS_REAL/lib.sh"
detect_layout
JOB_NAME=holder; trap job_on_exit EXIT
lock_acquire update
echo locked
sleep 5
EOF2
  bash "$SB/holder.sh" > "$SB/holder.out" 2>&1 &
  hp=$!
  for _ in $(seq 1 20); do grep -q locked "$SB/holder.out" 2>/dev/null && break; sleep 0.2; done
  assert_eq "$(update)" 1
  assert_contains "$(cat "$SB/out")" "già in corso"
  assert_eq "$(head_of)" "$C1"
  pkill -P "$hp" 2>/dev/null; kill "$hp" 2>/dev/null; wait "$hp" 2>/dev/null || true
}
test_6_senza_healthcheck_usa_la_sonda_di_riserva() {
  setup; echo none > "$STUB_DIR/inspect.out"
  assert_eq "$(update)" 0
  assert_contains "$(dc_log)" "exec -T web node -e fetch(\"http://127.0.0.1:3000/api/health\")" "sonda di riserva eseguita"
  echo 1 > "$STUB_DIR/probe_rc"
  git -C "$HOME_DIR/app" reset -q --hard "$C1"
  assert_eq "$(update)" 1 "sonda che fallisce → non sano → rollback"
  assert_eq "$(head_of)" "$C1"
}
test_non_git_si_aggancia_con_yes() {
  setup
  rm -rf "$HOME_DIR/app/.git"
  assert_eq "$(REPO_URL="$origin" update)" 1 "senza --yes e senza terminale: rifiuta"
  assert_contains "$(cat "$SB/out")" "--yes"
  assert_eq "$(REPO_URL="$origin" update --yes)" 0
  assert_eq "$(head_of)" "$C2"
}
test_remote_riportato_su_https_anonimo() {
  setup
  git -C "$HOME_DIR/app" remote set-url origin "https://token123@github.com/mydohome/soldi.git"
  git -C "$HOME_DIR/app" fetch -q origin 2>/dev/null || true
  update >/dev/null
  assert_eq "$(git -C "$HOME_DIR/app" remote get-url origin)" "https://github.com/mydohome/soldi.git"
  assert_not_contains "$(cat "$SB/out")" "token123"
}

run_tests
