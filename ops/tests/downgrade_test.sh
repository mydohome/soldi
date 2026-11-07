#!/usr/bin/env bash
# Test di ops/downgrade.sh con stub di docker/compose e repository git temporaneo.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

export HEALTH_TRIES=3 HEALTH_SLEEP=0

setup() {
  make_deploy
  origin="$SB/origin.git"; work="$SB/work"
  git init -q --bare "$origin"; git -C "$origin" symbolic-ref HEAD refs/heads/main
  git init -q "$work"; git -C "$work" config user.email t@t; git -C "$work" config user.name t
  git -C "$work" checkout -q -b main 2>/dev/null || true
  echo "v1" > "$work/file.txt"; git -C "$work" add -A; git -C "$work" commit -q -m "c1"
  C1="$(git -C "$work" rev-parse HEAD)"
  echo "v2" > "$work/file.txt"; git -C "$work" commit -qam "c2"
  C2="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" push -q "$origin" main

  rm -rf "$HOME_DIR/app"; git clone -q "$origin" "$HOME_DIR/app"
  git -C "$HOME_DIR/app" config user.email t@t; git -C "$HOME_DIR/app" config user.name t
  git -C "$HOME_DIR/app" reset -q --hard "$C1" 
  make_stack; make_curl_stub "$SB/cbin"
  export STUB_APP="$HOME_DIR/app"
  printf 'ALERT_TG_TOKEN=tk\nALERT_TG_CHAT=1\n' > "$HOME_DIR/ops.env"
}

head_of() { git -C "$HOME_DIR/app" rev-parse HEAD; }
update() { "$OPS_REAL/update.sh" "$@" >"$SB/out" 2>&1; echo $?; }
downgrade() { "$OPS_REAL/downgrade.sh" "$@" >"$SB/out" 2>&1; echo $?; }

test_1_downgrade_senza_snapshot_torna_al_commit_precedente() {
  setup
  assert_eq "$(update)" 0
  assert_eq "$(head_of)" "$C2"
  # Esegui downgrade senza snapshot preesistenti
  assert_eq "$(downgrade --yes --no-push)" 0
  assert_eq "$(head_of)" "$C1" "ripristinato commit C1"
  assert_contains "$(cat "$SB/out")" "Inizio downgrade"
}

test_2_downgrade_con_snapshot_tag() {
  setup
  # Crea esplicitamente uno snapshot tag
  git -C "$HOME_DIR/app" tag -a "pre-update-20261101-120000" "$C1" -m "Snapshot v1"
  assert_eq "$(update)" 0
  assert_eq "$(head_of)" "$C2"
  # Mostra lista
  assert_eq "$(downgrade --list)" 0
  assert_contains "$(cat "$SB/out")" "pre-update-"
  # Downgrade automatico all'ultimo snapshot
  assert_eq "$(downgrade --yes --no-push)" 0
  assert_eq "$(head_of)" "$C1" "ripristinato al tag C1"
  assert_eq "$(count_files "$HOME_DIR"/backups/dumps/pre-downgrade-*.sql.gz)" 1 "dump di sicurezza pre-downgrade"
}

test_3_downgrade_con_to_specifico() {
  setup
  git -C "$HOME_DIR/app" tag -a "pre-update-specific" "$C1" -m "Specific tag"
  assert_eq "$(update)" 0
  assert_eq "$(downgrade --to pre-update-specific --yes --no-push)" 0
  assert_eq "$(head_of)" "$C1"
}

test_4_downgrade_con_revert_e_push() {
  setup
  git -C "$HOME_DIR/app" tag -a "pre-update-tag" "$C1" -m "Snapshot"
  assert_eq "$(update)" 0
  assert_eq "$(head_of)" "$C2"
  # Downgrade con --push: crea commit di revert e pusha su origin main
  assert_eq "$(downgrade --to pre-update-tag --yes --push)" 0
  # Su origin, HEAD deve essere un commit di revert il cui contenuto è identico a C1
  origin_head="$(git -C "$origin" rev-parse HEAD)"
  assert_ne "$origin_head" "$C2" "origin avanzato con revert"
  # Il contenuto del file su origin deve essere tornato a v1
  file_content="$(git -C "$origin" show HEAD:file.txt)"
  assert_eq "$file_content" "v1" "contenuto su origin identico a v1"
}

run_tests
