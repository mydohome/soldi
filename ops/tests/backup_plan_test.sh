#!/usr/bin/env bash
# Test di ops/backup-plan.sh: rilevamento dei job esistenti, proposta dell'orario, scelte e crontab.
# shellcheck source=ops/tests/helpers.sh
. "$(dirname "$0")/helpers.sh"

STUDIO='30 2 * * * cd /srv/studio-capri && ./backup.sh >> backup.log 2>&1
30 2 * * * cd /srv/studio_odontoiatrico && ./backup.sh >> backup.log 2>&1'

# Stack con un crontab finto (file) e senza /etc/cron.d reali
setup() { # [contenuto-crontab]
  make_deploy; make_stack
  CRONFILE="$SB/crontab.txt"; printf '%s\n' "${1:-}" > "$CRONFILE"
  make_stub "$SB/bin/crontab" 'f="'"$CRONFILE"'"; if [ "${1:-}" = -l ]; then cat "$f"; else cat > "$f"; fi'
  export CRONTAB="$SB/bin/crontab" OPS_SYSTEM_CRON_FILES="$SB/nessun-file-di-sistema"
}
plan() { "$OPS_REAL/backup-plan.sh" "$@" >"$SB/out" 2>&1; echo $?; }
okv() { ( . "$OPS_REAL/lib.sh" >/dev/null 2>&1; read_kv "$HOME_DIR/ops.env" "$1" ); }

test_rileva_i_job_dello_studio_e_propone_un_orario_libero() {
  setup "$STUDIO"
  assert_eq "$(plan --dry-run)" 0
  out="$(cat "$SB/out")"
  assert_contains "$out" "02:30  ogni giorno"
  assert_contains "$out" "crontab di $(id -un) [backup]"
  assert_contains "$out" "studio-capri"; assert_contains "$out" "studio_odontoiatrico"
  assert_contains "$out" "backup interno di Soldi (BACKUP_CRON)"; assert_contains "$out" "03:00  dom"
  # 02:30 ×2 ogni giorno e 03:00 la domenica: l'orario libero più vicino alle 03:15 è 04:30 (90 minuti da entrambi)
  assert_contains "$out" "Orario proposto: 04:30"
  assert_contains "$out" "a 90 minuti dal job più vicino"
  assert_contains "$out" "--dry-run: nessuna modifica eseguita"
  assert_no_file "$HOME_DIR/ops.env"
  assert_eq "$(cat "$CRONFILE")" "$STUDIO" "crontab intatto"
}
test_senza_altri_job_propone_le_0315() {
  setup ""
  printf 'BACKUP_ENABLED=false\n' >> "$HOME_DIR/.env"
  plan --dry-run >/dev/null
  assert_contains "$(cat "$SB/out")" "Orario proposto: 03:15"
  assert_contains "$(cat "$SB/out")" "nessun altro job rilevato"
}
test_i_giorni_cambiano_la_proposta() {
  setup "$STUDIO"
  plan --dry-run --days lun,mer >/dev/null
  out="$(cat "$SB/out")"
  assert_contains "$out" "Orario proposto: 04:00" "il backup interno (solo domenica) non confligge con lun,mer"
  assert_contains "$out" "perdita massima di dati diventa"
}
test_ignora_il_blocco_di_soldi_gia_installato() {
  setup "$STUDIO
# BEGIN soldi (gestito da: ...)
30 4 * * * SOLDI_HOME='/x' /x/cronrun.sh backup -- /x/backup.sh
# END soldi"
  plan --dry-run >/dev/null
  assert_not_contains "$(cat "$SB/out")" "04:30  ogni giorno" "il nostro blocco non è un «altro job»"
  assert_contains "$(cat "$SB/out")" "Orario proposto: 04:30"
}
test_job_di_sistema_e_alias() {
  setup ""
  mkdir "$SB/cron.d"
  printf '# db\n0 4 * * * root /usr/local/bin/backup-db.sh\n@daily root /opt/rsync-casa.sh\nSHELL=/bin/sh\n' > "$SB/cron.d/db"
  OPS_SYSTEM_CRON_FILES="$SB/cron.d/db" plan --dry-run >/dev/null
  out="$(cat "$SB/out")"
  assert_contains "$out" "04:00  ogni giorno"; assert_contains "$out" "/usr/local/bin/backup-db.sh"
  assert_contains "$out" "00:00  ogni giorno"; assert_contains "$out" "rsync-casa.sh"
  assert_not_contains "$out" "root /usr" "il campo utente non fa parte del comando"
}
test_orari_complessi_e_intervalli() {
  setup '*/5 * * * * /usr/bin/ping-check
0 1,13 * * 1-5 /opt/job-feriali.sh
15 6 * * mon,fri /opt/job-nomi.sh'
  plan --dry-run >/dev/null
  out="$(cat "$SB/out")"
  assert_not_contains "$out" "ping-check" "gli intervalli */5 non occupano uno slot"
  assert_contains "$out" "01:00  lun, mar, mer, gio, ven"; assert_contains "$out" "13:00  lun, mar, mer, gio, ven"
  assert_contains "$out" "06:15  lun, ven"
}
test_yes_salva_installa_e_aggiorna_backup_keep() {
  setup "$STUDIO"
  assert_eq "$(plan --yes)" 0
  assert_eq "$(okv CRON_BACKUP_AT)" 04:30; assert_eq "$(okv CRON_BACKUP_DAYS)" '*'
  assert_eq "$(okv CRON_CHECK_AT)" 08:00;  assert_eq "$(okv DUMP_KEEP)" 14
  assert_eq "$(fmode "$HOME_DIR/ops.env")" 600
  assert_eq "$( ( . "$OPS_REAL/lib.sh" >/dev/null 2>&1; read_kv "$HOME_DIR/.env" BACKUP_KEEP ) )" 30 "con un backup al giorno BACKUP_KEEP passa a 30"
  n=0; for f in "$HOME_DIR"/.env.bak-*; do [ -f "$f" ] && n=$((n + 1)); done; assert_eq "$n" 1
  cron="$(cat "$CRONFILE")"
  assert_contains "$cron" "30 2 * * * cd /srv/studio-capri" "i job dello studio restano"
  assert_contains "$cron" "30 4 * * * SOLDI_HOME='$HOME_DIR'"
  assert_contains "$cron" "0 8 * * * SOLDI_HOME"
  assert_eq "$(grep -c '# BEGIN soldi' "$CRONFILE")" 1
  # rilanciare non duplica e non sposta nulla
  assert_eq "$(plan --yes)" 0
  assert_eq "$(grep -c '# BEGIN soldi' "$CRONFILE")" 1
  assert_eq "$(okv CRON_BACKUP_AT)" 04:30
}
test_at_giorni_e_no_install() {
  setup "$STUDIO"
  assert_eq "$(plan --yes --at 5:20 --days lun,mer,ven --no-install)" 0
  assert_eq "$(okv CRON_BACKUP_AT)" 05:20; assert_eq "$(okv CRON_BACKUP_DAYS)" 1,3,5
  assert_eq "$(okv CRON_RESTORETEST_AT)" 06:00 "la prova di ripristino si sposta se troppo vicina al backup"
  assert_eq "$(cat "$CRONFILE")" "$STUDIO" "--no-install: crontab non toccato"
  assert_contains "$(cat "$SB/out")" "soldi cron install"
  # poi cron install rispetta le scelte
  "$OPS_REAL/cron.sh" install >/dev/null 2>&1
  assert_contains "$(cat "$CRONFILE")" "20 5 * * 1,3,5 SOLDI_HOME"
}
test_input_non_valido() {
  setup "$STUDIO"
  assert_eq "$(plan --yes --at 25:00)" 1; assert_contains "$(cat "$SB/out")" "Orario non valido"
  assert_eq "$(plan --yes --at 3pm)" 1
  assert_eq "$(plan --yes --days funedi)" 1; assert_contains "$(cat "$SB/out")" "Giorni non validi"
  assert_no_file "$HOME_DIR/ops.env"
}
test_avvisa_se_l_orario_scelto_e_vicino_a_un_altro_job() {
  setup "$STUDIO"
  plan --yes --at 02:40 --no-install >/dev/null
  assert_contains "$(cat "$SB/out")" "Attenzione: alle 02:40 girano anche: 02:30"
}
test_interattivo_con_risposte_digitate() {
  setup "$STUDIO"
  # giorni, ora, dump, backup applicativi, salvo, installo, riavvio
  rc="$(printf 'lun,mer,ven\n03:40\n10\n20\ns\ns\nn\n' | PLAN_STDIN=1 "$OPS_REAL/backup-plan.sh" >"$SB/out" 2>&1; echo $?)"
  assert_eq "$rc" 0
  assert_eq "$(okv CRON_BACKUP_AT)" 03:40; assert_eq "$(okv CRON_BACKUP_DAYS)" 1,3,5; assert_eq "$(okv DUMP_KEEP)" 10
  assert_contains "$(cat "$CRONFILE")" "40 3 * * 1,3,5 SOLDI_HOME"
  assert_contains "$(cat "$SB/out")" "Righe che verranno installate"
  assert_contains "$(cat "$SB/out")" "docker compose up -d" "riavvio rifiutato: promemoria"
  assert_not_contains "$(dc_log)" "up -d"
}
test_interattivo_invio_accetta_le_proposte_e_n_annulla() {
  setup "$STUDIO"
  rc="$(printf '\n\n\n\ns\ns\ns\n' | PLAN_STDIN=1 "$OPS_REAL/backup-plan.sh" >"$SB/out" 2>&1; echo $?)"
  assert_eq "$rc" 0; assert_eq "$(okv CRON_BACKUP_AT)" 04:30
  assert_contains "$(dc_log)" "up -d" "riavvio accettato"
  setup "$STUDIO"
  rc="$(printf '\n\n\n\nn\n' | PLAN_STDIN=1 "$OPS_REAL/backup-plan.sh" >"$SB/out" 2>&1; echo $?)"
  assert_eq "$rc" 1; assert_contains "$(cat "$SB/out")" "Annullato"
  assert_no_file "$HOME_DIR/ops.env"
  assert_eq "$(cat "$CRONFILE")" "$STUDIO"
}
test_cron_rispetta_le_impostazioni_e_le_valida() {
  setup ""
  printf 'CRON_BACKUP_AT=04:30\nCRON_BACKUP_DAYS=1,3,5\nCRON_CHECK_AT=09:15\nCRON_RESTORETEST_AT=06:00\nCRON_WATCH_EVERY=10\n' > "$HOME_DIR/ops.env"
  out="$("$OPS_REAL/cron.sh" print)"
  assert_contains "$out" "*/10 * * * * SOLDI_HOME"; assert_contains "$out" "30 4 * * 1,3,5 SOLDI_HOME"
  assert_contains "$out" "15 9 * * * SOLDI_HOME"; assert_contains "$out" "0 6 * * 0 [ "
  printf 'CRON_BACKUP_AT=25:99\n' > "$HOME_DIR/ops.env"
  out="$("$OPS_REAL/cron.sh" print 2>&1)"; rc=$?; assert_ne "$rc" 0; assert_contains "$out" "non valido"
  printf 'CRON_BACKUP_DAYS=lun\n' > "$HOME_DIR/ops.env"
  out="$("$OPS_REAL/cron.sh" print 2>&1)"; rc=$?; assert_ne "$rc" 0; assert_contains "$out" "CRON_BACKUP_DAYS"
  printf 'CRON_WATCH_EVERY=0\n' > "$HOME_DIR/ops.env"
  out="$("$OPS_REAL/cron.sh" print 2>&1)"; rc=$?; assert_ne "$rc" 0
}
test_comando_soldi() {
  setup "$STUDIO"
  out="$("$OPS_REAL/soldi" backup-plan --dry-run 2>&1)"; rc=$?
  assert_rc "$rc" 0; assert_contains "$out" "Orario proposto"
  assert_contains "$("$OPS_REAL/soldi" help 2>&1)" "backup-plan"
}

run_tests
