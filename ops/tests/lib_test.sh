#!/usr/bin/env bash
# Test di ops/lib.sh: layout, lettura di .env/ops.env, stato dei job, lock.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

# Esegue codice che include lib.sh in una shell nuova, dalla cartella $1.
in_lib() { local dir="$1"; shift; ( cd "$dir" && bash -c ". '$OPS_REAL/lib.sh'; $*" ); }

test_layout_deploy_da_cartella_corrente() {
  make_deploy; unset SOLDI_HOME
  out="$(in_lib "$HOME_DIR" 'detect_layout; echo "$COMPOSE_DIR|$APP_DIR|$LAYOUT"' 2>&1)"
  assert_eq "$out" "$HOME_DIR|$HOME_DIR/app|deploy"
}
test_layout_deploy_da_app_ops_risalendo() {
  make_deploy; unset SOLDI_HOME
  # cwd = app/ (ha docker-compose.yml del repo ma non .env): si risale dallo script
  : > "$HOME_DIR/app/docker-compose.yml"
  out="$(in_lib "$HOME_DIR/app" 'OPS_DIR="'"$HOME_DIR"'/app/ops"; detect_layout; echo "$COMPOSE_DIR|$APP_DIR"' 2>&1)"
  assert_eq "$out" "$HOME_DIR|$HOME_DIR/app"
}
test_layout_repo() {
  make_repo; unset SOLDI_HOME
  out="$(in_lib "$HOME_DIR" 'detect_layout; echo "$COMPOSE_DIR|$APP_DIR|$LAYOUT"' 2>&1)"
  assert_eq "$out" "$HOME_DIR|$HOME_DIR|repo"
}
test_layout_con_home_e_variabile() {
  make_deploy; unset SOLDI_HOME
  out="$(in_lib "$SB_ROOT" 'SOLDI_HOME_ARG="'"$HOME_DIR"'"; detect_layout; echo "$COMPOSE_DIR"' 2>&1)"
  assert_eq "$out" "$HOME_DIR" "--home"
  out="$(cd "$SB_ROOT" && SOLDI_HOME="$HOME_DIR" bash -c ". '$OPS_REAL/lib.sh'; detect_layout; echo \$COMPOSE_DIR" 2>&1)"
  assert_eq "$out" "$HOME_DIR" "SOLDI_HOME"
}
test_layout_link_simbolico_nella_cartella_di_deploy() {
  make_deploy; unset SOLDI_HOME
  ln -s app/ops/soldi "$HOME_DIR/soldi"
  cat > "$SB/probe.sh" <<EOF2
#!/usr/bin/env bash
OPS_DIR="$OPS_REAL"
. "$OPS_REAL/lib.sh"
detect_layout
echo "\$COMPOSE_DIR"
EOF2
  chmod +x "$SB/probe.sh"; ln -s "$SB/probe.sh" "$HOME_DIR/probe"
  out="$(cd "$SB_ROOT" && "$HOME_DIR/probe" 2>&1)"
  assert_eq "$out" "$HOME_DIR" "invocato da un link nella cartella di deploy, da un'altra cartella"
}
test_layout_non_trovato() {
  make_deploy; unset SOLDI_HOME
  mkdir "$SB/vuota"
  out="$(in_lib "$SB/vuota" 'OPS_DIR="'"$SB"'/vuota"; OPS_INVOKED_DIR=""; detect_layout' 2>&1)"; rc=$?
  assert_ne "$rc" 0; assert_contains "$out" "Non trovo la cartella di Soldi"
}

test_envval_virgolette_spazi_commenti() {
  make_deploy
  out="$(in_lib "$HOME_DIR" 'detect_layout
    echo "[$(envval PGUSER)][$(envval PGDATABASE)][$(envval JWT_SECRET)][$(envval EMPTY)][$(envval ASSENTE)]"
    echo "[$(envval SECRETS_KEY)]"')"
  assert_contains "$out" "[soldi_u][soldi_db][abc def][][]"
  assert_contains "$out" "[0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef]"
}
test_envval_non_esegue_il_file() {
  make_deploy
  printf 'PGUSER=x\nBOOM=$(touch %s/pwned)\nOTHER=`touch %s/pwned2`\nLAST="a=b=c"\n' "$SB" "$SB" >> "$HOME_DIR/.env"
  out="$(in_lib "$HOME_DIR" 'detect_layout; echo "[$(envval BOOM)][$(envval LAST)]"')"
  assert_contains "$out" '[$(touch '"$SB"'/pwned)][a=b=c]'
  assert_no_file "$SB/pwned"; assert_no_file "$SB/pwned2"
}
test_opsval_precedenza_ambiente_e_ops_env() {
  make_deploy
  printf 'ALERT_TG_CHAT=123\nHC_PING_URL="https://hc.example/abc"\n' > "$HOME_DIR/ops.env"
  out="$(in_lib "$HOME_DIR" 'detect_layout; echo "$(opsval ALERT_TG_CHAT)|$(opsval HC_PING_URL)"')"
  assert_eq "$out" "123|https://hc.example/abc"
  out="$(cd "$HOME_DIR" && ALERT_TG_CHAT=999 bash -c ". '$OPS_REAL/lib.sh'; detect_layout; opsval ALERT_TG_CHAT")"
  assert_eq "$out" "999" "l'ambiente vince"
}
test_export_ops_prefix() {
  make_deploy
  printf 'AWS_ACCESS_KEY_ID=AK\nB2_ACCOUNT_KEY="k 2"\nALERT_TG_TOKEN=nonvaesportato\n' > "$HOME_DIR/ops.env"
  out="$(in_lib "$HOME_DIR" 'detect_layout; export_ops_prefix AWS_ B2_; echo "$AWS_ACCESS_KEY_ID|$B2_ACCOUNT_KEY|${ALERT_TG_TOKEN:-vuoto}"')"
  assert_eq "$out" "AK|k 2|vuoto"
}

test_state_write_contratto() {
  make_deploy
  in_lib "$HOME_DIR" 'detect_layout; JOB_NAME=backup; JOB_START=1700000000; OPS_NOW=1700000012; state_write backup ok "fatto \"bene\"" "{\"n\":3}"'
  f="$HOME_DIR/ops-state/backup.json"
  assert_file "$f"
  assert_eq "$(wc -l < "$f" | tr -d ' ')" 1 "una riga"
  body="$(cat "$f")"
  assert_contains "$body" '"version":1,"job":"backup","ok":true,"status":"ok"'
  assert_contains "$body" '"startedAt":"2023-11-14T22:13:20Z","finishedAt":"2023-11-14T22:13:32Z","durationMs":12000'
  assert_contains "$body" '"message":"fatto \"bene\""'
  assert_contains "$body" '"details":{"n":3}'
  assert_eq "$(file_perm=$(fmode "$f"); echo "$file_perm")" 600 "permessi 600"
  in_lib "$HOME_DIR" 'detect_layout; state_write backup fail "rotto"; state_write x warn "attenzione"'
  assert_contains "$(cat "$f")" '"ok":false,"status":"fail"'
  assert_contains "$(cat "$HOME_DIR/ops-state/x.json")" '"ok":true,"status":"warn"'
  assert_eq "$(in_lib "$HOME_DIR" 'detect_layout; state_field backup status')" fail
  tmpleft=0; for t in "$HOME_DIR"/ops-state/.*.json.*; do [ -e "$t" ] && tmpleft=1; done
  assert_eq "$tmpleft" 0 "nessun file temporaneo rimasto"
}
test_state_write_json_valido_con_node() {
  command -v node >/dev/null || { _pass; return 0; }
  make_deploy
  in_lib "$HOME_DIR" 'detect_layout; state_write t warn "riga1
riga2 \\ \" tab	fine" "{\"a\":[1,2]}"'
  out="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.version,j.job,j.ok,j.status,JSON.stringify(j.message),JSON.stringify(j.details))' "$HOME_DIR/ops-state/t.json")"
  assert_eq "$out" '1 t true warn "riga1\nriga2 \\ \" tab\tfine" {"a":[1,2]}'
}

test_job_fallito_scrive_stato_e_notifica() {
  make_deploy; make_curl_stub "$SB/bin"
  printf 'ALERT_TG_TOKEN=tok123\nALERT_TG_CHAT=42\n' > "$HOME_DIR/ops.env"
  cat > "$SB/job.sh" <<EOF2
#!/usr/bin/env bash
OPS_DIR="$OPS_REAL"
. "$OPS_REAL/lib.sh"
detect_layout
job_begin demo
die "qualcosa è andato storto"
EOF2
  bash "$SB/job.sh" >/dev/null 2>&1; rc=$?
  assert_rc "$rc" 1
  assert_contains "$(cat "$HOME_DIR/ops-state/demo.json")" '"ok":false'
  assert_contains "$(cat "$HOME_DIR/ops-state/demo.json")" 'qualcosa è andato storto'
  assert_contains "$(cat "$CURL_STDIN")" "qualcosa è andato storto"
}

test_lock_secondo_processo_rifiutato() {
  make_deploy
  cat > "$SB/holder.sh" <<EOF2
#!/usr/bin/env bash
OPS_DIR="$OPS_REAL"
. "$OPS_REAL/lib.sh"
detect_layout
JOB_NAME=holder; trap job_on_exit EXIT
lock_acquire provalock
echo locked
sleep 4
EOF2
  bash "$SB/holder.sh" > "$SB/holder.out" 2>&1 &
  hp=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q locked "$SB/holder.out" 2>/dev/null && break; sleep 0.2; done
  out="$(in_lib "$HOME_DIR" 'detect_layout; lock_acquire provalock' 2>&1)"; rc=$?
  assert_ne "$rc" 0 "il secondo deve fallire"
  assert_contains "$out" "già in corso"
  # i figli (sleep) ereditano il descrittore del lock: si fermano insieme al padre
  pkill -P "$hp" 2>/dev/null; kill "$hp" 2>/dev/null; wait "$hp" 2>/dev/null
  out="$(in_lib "$HOME_DIR" 'detect_layout; lock_acquire provalock; echo preso' 2>&1)"
  assert_contains "$out" "preso" "dopo la fine del primo il lock è di nuovo libero"
}

test_dump_verifica_e_prune() {
  make_deploy
  gz() { printf '%s\n' "$1" | gzip > "$2"; }
  gz '-- PostgreSQL database dump complete' "$SB/ok.gz"
  printf '%s\n' 'SELECT 1;' '-- PostgreSQL database dump complete' '--' '' '\unrestrict abc' | gzip > "$SB/ok2.gz"
  gz 'SELECT 1;' "$SB/troncato.gz"
  printf 'non gzip' > "$SB/rotto.gz"; : > "$SB/vuoto.gz"
  for f in ok ok2; do in_lib "$HOME_DIR" "verify_dump '$SB/$f.gz'"; assert_rc $? 0 "$f"; done
  for f in troncato rotto vuoto; do in_lib "$HOME_DIR" "verify_dump '$SB/$f.gz'"; assert_ne $? 0 "$f"; done
  mkdir "$SB/d"; for i in 1 2 3 4 5; do : > "$SB/d/soldi-$i.sql.gz"; touch -t "20260101000$i" "$SB/d/soldi-$i.sql.gz"; done
  in_lib "$HOME_DIR" "prune_keep '$SB/d' 'soldi-*.sql.gz' 2"
  assert_eq "$(ls "$SB/d" | tr '\n' ' ')" "soldi-4.sql.gz soldi-5.sql.gz "
}

test_manifest_helpers_e_ultimo_backup() {
  make_deploy
  mkdir -p "$HOME_DIR/backups/soldi-backup-2026-09-13_03-00-00" "$HOME_DIR/backups/soldi-backup-2026-09-13_03-00-00-500" "$HOME_DIR/backups/soldi-backup-2026-09-20_03-00-00-250" "$HOME_DIR/backups/soldi-user-backup-1-a-2026-12-01_00-00-00-000"
  cat > "$HOME_DIR/backups/soldi-backup-2026-09-20_03-00-00-250/manifest.json" <<'J'
{
  "app": "soldi",
  "format": 1,
  "label": "auto",
  "createdAt": "2026-09-20T03:00:00.250Z",
  "tables": {
    "users": { "rows": 3, "file": "users.csv" },
    "transactions": { "rows": 120, "file": "transactions.csv" }
  }
}
J
  m="$HOME_DIR/backups/soldi-backup-2026-09-20_03-00-00-250/manifest.json"
  out="$(in_lib "$HOME_DIR" "detect_layout; latest_app_backup; manifest_rows '$m' transactions; manifest_tables '$m' | tr '\n' ,; manifest_value '$m' createdAt")"
  assert_contains "$out" "soldi-backup-2026-09-20_03-00-00-250"
  assert_not_contains "$out" "soldi-user-backup"
  assert_contains "$out" "120"
  assert_contains "$out" "users 3,transactions 120,"
  assert_contains "$out" "2026-09-20T03:00:00.250Z"
}

run_tests
