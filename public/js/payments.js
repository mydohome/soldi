// Pagamenti programmati ("Da pagare"): bollettini a scadenza definita, pagati a mano.
// Schermata dentro Spese fisse, pop-up all'apertura dell'app, badge sul menu, card in Dashboard.
// Riceve gli helper dell'app (modal, toast, …) da app.js per non creare dipendenze circolari.

export function initPayments(ctx) {
  const {
    state, api, h, modal, toast, choiceModal, escapeHtml, fmtEur, icons, scopeBadge, catField, wireQuickCat,
    today, refreshView, goToFisse, emptyState, txRow, bindTxRows, openTxModal,
  } = ctx;

  const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const addDaysISO = (s, n) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** Testo breve dello stato di una rata non pagata. */
  function statusText(i) {
    if (i.status === 'overdue') return `scaduta da ${plural(i.daysOverdue, 'giorno', 'giorni')}`;
    if (i.status === 'today') return 'scade oggi';
    if (i.daysToDue === 1) return 'scade domani';
    return `scade tra ${i.daysToDue} giorni`;
  }

  /* ------------------------------------------------------------ scadenze da segnalare + badge */
  state.due = { alert: [], upcoming: [], counts: { alert: 0, overdue: 0, upcoming: 0 } };

  function setBadge(n) {
    document.querySelectorAll('.nav-link[href="#/fisse"], .tabbar button[data-view="fisse"]').forEach((el) => {
      el.querySelector('.nav-badge')?.remove();
      if (n > 0) {
        el.appendChild(h(`<span class="nav-badge" role="img" aria-label="${plural(n, 'rata da pagare', 'rate da pagare')}">${n > 9 ? '9+' : n}</span>`));
      }
    });
  }

  /** Rilegge le scadenze dal server e aggiorna il badge. Errori di rete: si tiene l'ultimo stato noto. */
  async function refreshDue() {
    try {
      state.due = await api.paymentsDue(7);
    } catch {
      /* il promemoria è un extra: senza rete non blocca l'app */
    }
    setBadge(state.due.counts.alert);
    return state.due;
  }

  /* ------------------------------------------------------------ registrazione del pagamento */
  async function openPayModal(item, onDone) {
    const accounts = state._accounts || (await api.accounts()).accounts;
    state._accounts = accounts;
    const { bd, close } = modal(`
      <h2>Registra pagamento</h2>
      <p class="muted" style="margin:-8px 0 14px">${escapeHtml(item.planName)} · rata ${item.number}/${item.total} · scadenza ${dmy(item.dueOn)}</p>
      <form id="pay-form">
        <div class="row-2">
          <div class="field">
            <label for="pdate">Data del pagamento</label>
            <input id="pdate" name="occurredOn" type="date" required value="${today()}" />
          </div>
          <div class="field">
            <label for="pamount">Importo (€)</label>
            <input id="pamount" name="amount" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${item.amount}" />
          </div>
        </div>
        <div class="field">
          <label for="pacc">Conto</label>
          <select id="pacc" name="accountId">
            <option value="">Nessun conto</option>
            ${accounts
              .map((a) => `<option value="${a.id}" ${String(a.id) === String(item.accountId) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="pnote">Nota</label>
          <input id="pnote" name="note" maxlength="280" value="${escapeHtml(`${item.planName} ${item.number} di ${item.total}`)}" />
        </div>
        <span class="error" id="pay-err"></span>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="pay-cancel">Annulla</button>
          <button type="submit" class="btn primary">${icons.check}<span>Registra</span></button>
        </div>
      </form>`);
    const form = bd.querySelector('#pay-form');
    form.querySelector('#pay-cancel').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.post(`/api/payments/installments/${item.id}/pay`, {
          occurredOn: fd.occurredOn,
          amount: Number(fd.amount),
          accountId: fd.accountId ? Number(fd.accountId) : null,
          note: fd.note || '',
        });
        close();
        toast(`Rata ${item.number}/${item.total} registrata`);
        await onDone?.();
      } catch (ex) {
        form.querySelector('#pay-err').textContent = ex.details?.[0]?.message || ex.message;
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ pop-up all'apertura dell'app */
  function openDuePopup() {
    if (state.duePopupOpen) return;
    state.duePopupOpen = true;
    const { bd, close } = modal(
      `<h2 class="due-title">${icons.bell}<span>Rate da pagare</span></h2>
       <div id="due-list"></div>
       <div class="modal-actions choice-actions">
         <button type="button" class="btn ghost" id="due-later">Più tardi</button>
         <button type="button" class="btn primary" id="due-go">Vai a «Da pagare»</button>
       </div>`,
      () => {
        state.duePopupOpen = false;
      }
    );
    const list = bd.querySelector('#due-list');
    const render = () => {
      const items = state.due.alert;
      list.innerHTML = `
        <p class="muted" style="margin:-8px 0 12px">${
          items.length === 1 ? 'C’è una rata scaduta o in scadenza oggi.' : `Ci sono ${items.length} rate scadute o in scadenza oggi.`
        } Spariscono appena registri il pagamento.</p>
        ${items
          .map(
            (i) => `
          <div class="due-item ${i.status}" data-id="${i.id}">
            <div class="due-main">
              <div class="due-name">${escapeHtml(i.planName)}</div>
              <div class="due-sub"><span class="due-state ${i.status}">${statusText(i)}</span> · rata ${i.number}/${i.total} · ${dmy(i.dueOn)}</div>
            </div>
            <div class="due-amount">${fmtEur(i.amount)}</div>
            <button type="button" class="btn primary due-pay">Paga</button>
          </div>`
          )
          .join('')}`;
    };
    render();
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.due-pay');
      if (!btn) return;
      const item = state.due.alert.find((i) => String(i.id) === btn.closest('.due-item').dataset.id);
      if (!item) return;
      openPayModal(item, async () => {
        await refreshDue();
        refreshView();
        if (state.due.alert.length === 0) close();
        else render();
      });
    });
    bd.querySelector('#due-later').addEventListener('click', close);
    bd.querySelector('#due-go').addEventListener('click', () => {
      close();
      goToFisse('pagare');
    });
  }

  /** Dopo il login/avvio: aggiorna il badge e, una sola volta per sessione, mostra il pop-up. */
  async function checkOnOpen() {
    const due = await refreshDue();
    if (due.counts.alert > 0 && !state.duePrompted) {
      state.duePrompted = true;
      openDuePopup();
    }
  }

  /* ------------------------------------------------------------ card in Dashboard */
  function dueCardHtml() {
    const items = [...state.due.alert, ...state.due.upcoming].filter((i) => !state.scope || i.scope === state.scope);
    if (!items.length) return '';
    const shown = items.slice(0, 4);
    return `
      <div class="card card-pad due-card" id="due-card" style="margin-top:16px">
        <div class="due-head">
          <h3>${icons.bell}<span>Da pagare</span></h3>
          <a href="#/fisse" id="due-all">Vedi tutte${items.length > shown.length ? ` (${items.length})` : ''}</a>
        </div>
        ${shown
          .map(
            (i) => `
          <div class="due-item ${i.status}" data-id="${i.id}">
            <div class="due-main">
              <div class="due-name">${escapeHtml(i.planName)}</div>
              <div class="due-sub"><span class="due-state ${i.status}">${statusText(i)}</span> · rata ${i.number}/${i.total} · ${dmy(i.dueOn)}</div>
            </div>
            <div class="due-amount">${fmtEur(i.amount)}</div>
            <button type="button" class="btn ${i.status === 'upcoming' ? '' : 'primary'} due-pay">Paga</button>
          </div>`
          )
          .join('')}
      </div>`;
  }

  function bindDueCard(main, onChange) {
    main.querySelector('#due-all')?.addEventListener('click', (e) => {
      e.preventDefault();
      goToFisse('pagare');
    });
    main.querySelectorAll('#due-card .due-pay').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.closest('.due-item').dataset.id;
        const item = [...state.due.alert, ...state.due.upcoming].find((i) => String(i.id) === id);
        if (item) openPayModal(item, async () => { await refreshDue(); onChange(); });
      })
    );
  }

  /* ------------------------------------------------------------ interruttore Ricorrenti | Da pagare */
  function fisseTabsHtml(active) {
    const n = state.due.counts.alert;
    return `
      <div class="segment fisse-tabs" id="fisse-tabs">
        <button data-tab="ricorrenti" class="${active === 'ricorrenti' ? 'active' : ''}">Ricorrenti</button>
        <button data-tab="pagare" class="${active === 'pagare' ? 'active' : ''}">Da pagare${n > 0 ? `<span class="tab-count">${n}</span>` : ''}</button>
      </div>`;
  }
  function bindFisseTabs(main) {
    main.querySelectorAll('#fisse-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        state.fisseTab = b.dataset.tab;
        refreshView();
      })
    );
  }

  /* ------------------------------------------------------------ modali di piano e rata */
  function openInstModal(plan, inst, onChange) {
    const editing = !!inst;
    const last = plan.installments[plan.installments.length - 1];
    const { bd, close } = modal(`
      <h2>${editing ? `Modifica rata ${inst.number}/${inst.total}` : 'Nuova rata'}</h2>
      <p class="muted" style="margin:-8px 0 14px">${escapeHtml(plan.name)}</p>
      <form id="inst-form">
        <div class="row-2">
          <div class="field">
            <label for="idue">Scadenza</label>
            <input id="idue" name="dueOn" type="date" required value="${editing ? inst.dueOn : addDaysISO(last?.dueOn || today(), 30)}" />
          </div>
          <div class="field">
            <label for="iamount">Importo (€)</label>
            <input id="iamount" name="amount" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${editing ? inst.amount : last?.amount ?? ''}" />
          </div>
        </div>
        <span class="error" id="inst-err"></span>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="inst-cancel">Annulla</button>
          <button type="submit" class="btn primary">${editing ? 'Salva' : 'Aggiungi'}</button>
        </div>
      </form>`);
    const form = bd.querySelector('#inst-form');
    form.querySelector('#inst-cancel').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const body = { dueOn: fd.dueOn, amount: Number(fd.amount) };
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        if (editing) await api.patch(`/api/payments/installments/${inst.id}`, body);
        else await api.post(`/api/payments/${plan.id}/installments`, body);
        close();
        toast(editing ? 'Rata aggiornata' : 'Rata aggiunta');
        onChange();
      } catch (ex) {
        form.querySelector('#inst-err').textContent = ex.details?.[0]?.message || ex.message;
        btn.disabled = false;
      }
    });
  }

  // «Rate uguali»: stesso importo per ogni rata da pagare, oppure un totale da dividere tra di esse.
  // Le rate già pagate non cambiano.
  function openEqualizeModal(plan, onChange) {
    const open = plan.installments.filter((i) => !i.paid);
    const residual = open.reduce((s, i) => s + Math.round(i.amount * 100), 0) / 100;
    const { bd, close } = modal(`
      <h2>Rate uguali</h2>
      <p class="muted" style="margin:-8px 0 14px">${escapeHtml(plan.name)} · ${plural(open.length, 'rata da pagare', 'rate da pagare')}, quelle già pagate non cambiano</p>
      <form id="eq-form">
        <div class="segment" id="eq-mode" style="margin-bottom:14px">
          <button type="button" data-m="each" class="active">Stesso importo</button>
          <button type="button" data-m="total">Dividi un totale</button>
        </div>
        <div class="field">
          <label for="eq-amount" id="eq-label">Importo di ogni rata (€)</label>
          <input id="eq-amount" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${open[0]?.amount ?? ''}" />
          <span class="muted" id="eq-preview" style="font-size:.82rem"></span>
        </div>
        <span class="error" id="eq-err"></span>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="eq-cancel">Annulla</button>
          <button type="submit" class="btn primary">Applica</button>
        </div>
      </form>`);
    const form = bd.querySelector('#eq-form');
    const amountEl = form.querySelector('#eq-amount');
    const preview = form.querySelector('#eq-preview');
    let mode = 'each';
    const paint = () => {
      const v = Math.round(Number(amountEl.value) * 100);
      if (!(v > 0)) return (preview.textContent = '');
      if (mode === 'each') {
        preview.textContent = `${plural(open.length, 'rata', 'rate')} da ${fmtEur(v / 100)} = ${fmtEur((v * open.length) / 100)} in totale.`;
        return;
      }
      const base = Math.floor(v / open.length);
      const last = v - base * (open.length - 1);
      preview.textContent =
        base <= 0
          ? 'Totale troppo basso per questo numero di rate.'
          : last === base
            ? `${plural(open.length, 'rata', 'rate')} da ${fmtEur(base / 100)}.`
            : `${open.length - 1} da ${fmtEur(base / 100)} e l'ultima da ${fmtEur(last / 100)}.`;
    };
    form.querySelector('#eq-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mode = b.dataset.m;
      form.querySelectorAll('#eq-mode button').forEach((x) => x.classList.toggle('active', x === b));
      form.querySelector('#eq-label').textContent = mode === 'total' ? 'Totale da dividere (€)' : 'Importo di ogni rata (€)';
      amountEl.value = mode === 'total' ? residual : open[0]?.amount ?? '';
      paint();
    });
    amountEl.addEventListener('input', paint);
    paint();
    form.querySelector('#eq-cancel').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.post(`/api/payments/${plan.id}/equalize`, { mode, amount: Number(amountEl.value) });
        close();
        toast('Rate aggiornate');
        onChange();
      } catch (ex) {
        form.querySelector('#eq-err').textContent = ex.details?.[0]?.message || ex.message;
        btn.disabled = false;
      }
    });
  }

  async function openPlanModal(plan = null, onChange) {
    const cats = state._categories || (await api.categories()).categories;
    const accounts = state._accounts || (await api.accounts()).accounts;
    state._categories = cats;
    state._accounts = accounts;
    const editing = !!plan;
    const p = plan || { name: '', categoryId: null, accountId: accounts[0]?.id ?? null, scope: 'home', note: '' };
    const firstDefault = addDaysISO(today(), 30);

    const { bd, close } = modal(`
      <h2>${editing ? 'Modifica piano di pagamento' : 'Nuovo piano di pagamento'}</h2>
      <form id="plan-form">
        <div class="field">
          <label for="pname">Nome</label>
          <input id="pname" name="name" required maxlength="80" value="${escapeHtml(p.name)}" placeholder="Es. Condominio lavori straordinari" />
        </div>
        ${catField('pcat', 'Categoria', 'categoryId')}
        <div class="field">
          <label for="pacc2">Conto</label>
          <select id="pacc2" name="accountId">
            <option value="">Nessun conto</option>
            ${accounts
              .map((a) => `<option value="${a.id}" ${String(a.id) === String(p.accountId) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>Ambito</label>
          <label class="switch-row">
            <span class="switch-label personal ${p.scope === 'personal' ? 'on' : ''}">${icons.person}Personale</span>
            <span class="switch"><input type="checkbox" id="pscope" ${p.scope === 'home' ? 'checked' : ''} /><span class="switch-track"></span></span>
            <span class="switch-label home ${p.scope === 'home' ? 'on' : ''}">${icons.home}Casa</span>
          </label>
        </div>
        <div class="field">
          <label for="pnote2">Nota</label>
          <input id="pnote2" name="note" maxlength="280" value="${escapeHtml(p.note || '')}" placeholder="Facoltativa" />
        </div>
        <h3 class="plan-gen-title">Rate</h3>
        ${
          editing
            ? ''
            : `
        <div class="segment" id="gmode-seg" style="margin-bottom:14px">
          <button type="button" data-m="each" class="active">Importo di ogni rata</button>
          <button type="button" data-m="total">Totale da dividere</button>
        </div>
        <div class="row-2">
          <div class="field">
            <label for="gcount">Numero di rate</label>
            <input id="gcount" type="number" min="1" max="120" inputmode="numeric" value="12" />
          </div>
          <div class="field">
            <label for="gamount" id="gamount-label">Importo di ogni rata (€)</label>
            <input id="gamount" type="number" step="0.01" min="0.01" inputmode="decimal" />
          </div>
        </div>
        <div class="row-2">
          <div class="field">
            <label for="gfirst">Prima scadenza</label>
            <input id="gfirst" type="date" value="${firstDefault}" />
          </div>
          <div class="field">
            <label for="gevery">Una rata ogni</label>
            <select id="gevery">
              <option value="1">mese</option>
              <option value="2">2 mesi</option>
              <option value="3">3 mesi</option>
              <option value="6">6 mesi</option>
              <option value="12">anno</option>
            </select>
          </div>
        </div>
        <button type="button" class="btn" id="gen-btn">Calcola le rate</button>
        <p class="muted" style="font-size:.82rem;margin:8px 0 0">Poi puoi correggere data e importo di ogni singola rata.</p>`
        }
        <div id="inst-table" ${editing ? '' : 'hidden'}></div>
        <button type="button" class="btn ghost small" id="add-row" ${editing ? '' : 'hidden'}>${icons.plus}<span>Aggiungi rata</span></button>
        ${editing ? '<p class="muted" style="font-size:.82rem;margin:8px 0 0">Le rate già pagate non si cambiano da qui: modifica il movimento collegato.</p>' : ''}
        <span class="error" id="plan-err"></span>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="plan-cancel">Annulla</button>
          <button type="submit" class="btn primary" id="plan-save" ${editing ? '' : 'disabled'}>${editing ? 'Salva' : 'Crea piano'}</button>
        </div>
      </form>`);

    const form = bd.querySelector('#plan-form');
    const errEl = form.querySelector('#plan-err');
    let scope = p.scope;
    const catSel = form.querySelector('#pcat');
    const fillCats = (sel = p.categoryId) => {
      const opts = cats.filter((c) => c.kind === 'expense' && c.scope === scope);
      catSel.innerHTML =
        '<option value="">Senza categoria</option>' +
        opts.map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    };
    fillCats();
    wireQuickCat(form, { selectId: 'pcat', cats, getKind: () => 'expense', getScope: () => scope, refill: fillCats });
    const scopeInput = form.querySelector('#pscope');
    scopeInput.addEventListener('change', () => {
      scope = scopeInput.checked ? 'home' : 'personal';
      form.querySelector('.switch-label.personal').classList.toggle('on', scope === 'personal');
      form.querySelector('.switch-label.home').classList.toggle('on', scope === 'home');
      fillCats(catSel.value || p.categoryId);
    });
    form.querySelector('#plan-cancel').addEventListener('click', close);

    // Tabella delle rate: in creazione la riempie il generatore, in modifica parte da tutte le rate del
    // piano (le pagate sono bloccate). Il totale si ricalcola a ogni modifica.
    let rows = editing
      ? plan.installments.map((i) => ({ id: i.id, dueOn: i.dueOn, amount: i.paid ? i.paidAmount : i.amount, paid: i.paid }))
      : [];
    let mode = 'each';
    const table = form.querySelector('#inst-table');
    const save = form.querySelector('#plan-save');
    const addRow = form.querySelector('#add-row');
    const cents = (v) => Math.round(Number(v || 0) * 100);
    const totalOf = () => rows.reduce((sum, r) => sum + cents(r.amount), 0) / 100;
    const headHtml = () => {
      const paidN = rows.filter((r) => r.paid).length;
      return `<span>${plural(rows.length, 'rata', 'rate')}${paidN ? ` · ${paidN} pagate` : ''}</span><strong>Totale ${fmtEur(totalOf())}</strong>`;
    };
    const nextMonthISO = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
    };
    const renderTable = () => {
      table.hidden = rows.length === 0;
      addRow.hidden = rows.length === 0;
      if (!editing) save.disabled = rows.length === 0;
      table.innerHTML = `
        <div class="inst-edit-head">${headHtml()}</div>
        ${rows
          .map(
            (r, i) => `
          <div class="inst-edit-row ${r.paid ? 'paid' : ''}" data-i="${i}">
            <span class="inst-num" ${r.paid ? 'title="Pagata"' : ''}>${r.paid ? icons.check : i + 1}</span>
            <input type="date" class="ir-date" value="${r.dueOn}" aria-label="Scadenza rata ${i + 1}" ${r.paid ? 'disabled' : ''} />
            <input type="number" class="ir-amount" step="0.01" min="0.01" inputmode="decimal" value="${r.amount}" aria-label="Importo rata ${i + 1}" ${r.paid ? 'disabled' : ''} />
            <button type="button" class="icon-btn ir-del" aria-label="Rimuovi rata ${i + 1}" ${r.paid || rows.length === 1 ? 'disabled' : ''}>${icons.trash}</button>
          </div>`
          )
          .join('')}`;
    };
    table.addEventListener('input', (e) => {
      const row = e.target.closest('.inst-edit-row');
      if (!row) return;
      const r = rows[Number(row.dataset.i)];
      if (r.paid) return;
      if (e.target.classList.contains('ir-date')) r.dueOn = e.target.value;
      if (e.target.classList.contains('ir-amount')) {
        r.amount = e.target.value === '' ? '' : Number(e.target.value);
        table.querySelector('.inst-edit-head').innerHTML = headHtml();
      }
    });
    table.addEventListener('click', (e) => {
      const del = e.target.closest('.ir-del');
      if (!del || del.disabled || rows.length === 1) return;
      rows.splice(Number(del.closest('.inst-edit-row').dataset.i), 1);
      renderTable();
    });
    addRow.addEventListener('click', () => {
      const last = rows[rows.length - 1];
      rows.push({ dueOn: nextMonthISO(last?.dueOn || today()), amount: last?.amount || '' });
      renderTable();
      table.scrollTop = table.scrollHeight;
    });
    if (editing) renderTable();

    // Generatore delle rate (solo in creazione): il server calcola, l'utente corregge le righe.
    if (!editing) {
      form.querySelector('#gmode-seg').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        mode = b.dataset.m;
        form.querySelectorAll('#gmode-seg button').forEach((x) => x.classList.toggle('active', x === b));
        form.querySelector('#gamount-label').textContent = mode === 'total' ? 'Totale da dividere (€)' : 'Importo di ogni rata (€)';
      });
      form.querySelector('#gen-btn').addEventListener('click', async () => {
        errEl.textContent = '';
        const amount = Number(form.querySelector('#gamount').value);
        if (!(amount > 0)) {
          errEl.textContent = mode === 'total' ? 'Inserisci il totale da dividere' : 'Inserisci l’importo di ogni rata';
          return;
        }
        try {
          const res = await api.post('/api/payments/generate', {
            count: Number(form.querySelector('#gcount').value),
            firstDue: form.querySelector('#gfirst').value,
            everyMonths: Number(form.querySelector('#gevery').value),
            mode,
            amount,
          });
          rows = res.installments;
          renderTable();
        } catch (ex) {
          errEl.textContent = ex.details?.[0]?.message || ex.message;
        }
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const fd = Object.fromEntries(new FormData(form));
      const body = {
        name: fd.name,
        categoryId: fd.categoryId ? Number(fd.categoryId) : null,
        accountId: fd.accountId ? Number(fd.accountId) : null,
        scope,
        note: fd.note || '',
      };
      // In modifica si inviano solo le rate non pagate (con id = aggiorna, senza = nuova; le tolte si eliminano).
      const sent = rows.filter((r) => !r.paid);
      if (sent.some((r) => !r.dueOn || !(Number(r.amount) > 0))) {
        errEl.textContent = 'Ogni rata deve avere una data e un importo maggiore di zero';
        return;
      }
      body.installments = sent.map((r) => ({ ...(r.id ? { id: r.id } : {}), dueOn: r.dueOn, amount: Number(r.amount) }));
      const btn = form.querySelector('#plan-save');
      btn.disabled = true;
      try {
        if (editing) await api.patch(`/api/payments/${plan.id}`, body);
        else await api.post('/api/payments', body);
        close();
        toast(editing ? 'Piano aggiornato' : 'Piano creato');
        await onChange();
      } catch (ex) {
        errEl.textContent = ex.details?.[0]?.message || ex.message;
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ movimenti collegati a un piano */
  // Elenco di tutti i movimenti che saldano rate del piano: si modificano o eliminano da qui e il
  // piano (avanzamento, residuo) si aggiorna da solo perché legge importo e data dal movimento.
  async function openPlanMovements(plan) {
    const { bd, close } = modal(`
      <h2>${escapeHtml(plan.name)}</h2>
      <p class="muted" id="pm-sub" style="margin:-8px 0 12px"></p>
      <div id="pm-list" class="pm-list"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="pm-close">Chiudi</button>
      </div>`);
    bd.querySelector('#pm-close').addEventListener('click', close);
    const list = bd.querySelector('#pm-list');
    const sub = bd.querySelector('#pm-sub');
    const load = async () => {
      let txs;
      let cur;
      try {
        const [t, p] = await Promise.all([api.transactions(`paymentPlanId=${plan.id}&limit=500`), api.payments()]);
        txs = t.transactions;
        cur = p.plans.find((x) => x.id === plan.id);
      } catch (e) {
        list.innerHTML = `<div class="empty">Errore nel caricamento: ${escapeHtml(e.message)}</div>`;
        return;
      }
      if (!cur) return close(); // piano eliminato nel frattempo
      const g = cur.progress;
      sub.innerHTML = `${g.paidCount} di ${g.total} rate pagate · versato <strong>${fmtEur(g.paidAmount)}</strong> · residuo ${fmtEur(g.remainingAmount)}`;
      list.innerHTML = txs.length
        ? txs.map(txRow).join('')
        : emptyState('Nessun movimento collegato. Registra un pagamento con «Paga» oppure collega un movimento esistente dalla sua modifica.');
      bindTxRows(list, async () => {
        await load();
        refreshView();
      });
    };
    await load();
  }

  /* ------------------------------------------------------------ schermata «Da pagare» */
  async function viewDaPagare(main) {
    let data;
    try {
      [data] = await Promise.all([api.payments(), refreshDue()]);
    } catch (e) {
      main.innerHTML = `<div class="empty">Errore nel caricamento: ${escapeHtml(e.message)}</div>`;
      return;
    }
    const { plans } = data;
    const reload = () => refreshView();

    const unpaid = plans.flatMap((p) => p.installments.filter((i) => !i.paid));
    const overdue = unpaid.filter((i) => i.status === 'overdue');
    const soon = unpaid.filter((i) => i.status !== 'overdue' && i.daysToDue <= 30);
    const sum = (list) => list.reduce((s, i) => s + Math.round(i.amount * 100), 0) / 100;

    const instRow = (plan, i) => `
      <div class="inst-row ${i.status}" data-inst="${i.id}" data-plan="${plan.id}">
        <span class="inst-num">${i.number}</span>
        <div class="inst-main">
          <strong>${dmy(i.dueOn)}</strong>
          <span class="inst-state ${i.status}">${
            i.paid ? `pagata il ${dmy(i.paidOn)}` : statusText(i)
          }</span>
        </div>
        <span class="inst-amount">${fmtEur(i.paid ? i.paidAmount : i.amount)}</span>
        <div class="inst-actions">
          ${
            i.paid
              ? `<button type="button" class="icon-btn edit-pay" aria-label="Modifica pagamento">${icons.edit}</button>
                 <button type="button" class="btn ghost small undo-pay">Annulla pagamento</button>`
              : `<button type="button" class="btn ${i.status === 'upcoming' ? '' : 'primary'} small pay-inst">Paga</button>
                 <button type="button" class="icon-btn edit-inst" aria-label="Modifica rata">${icons.edit}</button>
                 <button type="button" class="icon-btn del-inst" aria-label="Elimina rata">${icons.trash}</button>`
          }
        </div>
      </div>`;

    const planCard = (p) => {
      const g = p.progress;
      return `
      <div class="card plan-card ${g.completed ? 'is-done' : ''}" data-plan="${p.id}">
        <div class="plan-head">
          <span class="dot" style="background:${p.categoryColor || 'var(--brand)'}"></span>
          <button type="button" class="meta plan-title show-moves" title="Vedi i movimenti collegati">
            <div class="name">${escapeHtml(p.name)} ${scopeBadge(p.scope)}</div>
            <div class="cat">${[p.categoryName, p.accountName, p.note].filter(Boolean).map(escapeHtml).join(' · ') || '&nbsp;'}</div>
          </button>
          <div class="row-tail">
            <button type="button" class="icon-btn edit-plan" aria-label="Modifica piano">${icons.edit}</button>
            <button type="button" class="icon-btn del-plan" aria-label="Elimina piano">${icons.trash}</button>
          </div>
        </div>
        <div class="rule-progress ${g.completed ? 'is-done' : ''}">
          <div class="rule-progress-head">
            <span>${g.paidCount} di ${g.total} rate pagate${g.completed ? ' · <strong>Completato</strong>' : ''}</span>
            <span class="pct">${g.percent}%</span>
          </div>
          <div class="progress-track" role="progressbar" aria-label="Avanzamento di ${escapeHtml(p.name)}"
               aria-valuemin="0" aria-valuemax="${g.total}" aria-valuenow="${g.paidCount}"
               aria-valuetext="${g.paidCount} di ${g.total} rate pagate, ${g.percent}%">
            <div class="progress-fill" style="width:${g.percent}%"></div>
          </div>
          <div class="rule-progress-foot">
            ${g.completed ? '' : `<span>Residuo ${fmtEur(g.remainingAmount)}</span>`}
            <span>Pagato ${fmtEur(g.paidAmount)} di ${fmtEur(g.totalAmount)}</span>
            ${g.next ? `<span>Prossima: ${dmy(g.next.dueOn)}${g.overdueCount ? ` · <strong class="late">${plural(g.overdueCount, 'scaduta', 'scadute')}</strong>` : ''}</span>` : ''}
          </div>
          <button type="button" class="btn ghost small show-moves">${icons.list}<span>Movimenti collegati (${g.paidCount})</span></button>
        </div>
        <details class="plan-insts" ${g.completed ? '' : 'open'}>
          <summary>Rate (${g.total})</summary>
          ${p.installments.map((i) => instRow(p, i)).join('')}
          <div class="inst-foot">
            <button type="button" class="btn ghost small add-inst">${icons.plus}<span>Aggiungi rata</span></button>
            ${g.completed ? '' : `<button type="button" class="btn ghost small equalize">${icons.refresh}<span>Rate uguali</span></button>`}
          </div>
        </details>
      </div>`;
    };

    main.innerHTML = '';
    const page = h(`
      <div>
        <div class="page-head">
          <div><h1>Spese fisse</h1><p>Bollettini e pagamenti a scadenza, da registrare quando li paghi</p></div>
          <div style="display:flex;gap:8px">
            <button class="btn primary" id="add-plan">${icons.plus}<span>Nuovo piano</span></button>
          </div>
        </div>
        ${fisseTabsHtml('pagare')}
        <div class="grid cols-2" style="margin:14px 0 6px">
          <div class="card stat expense">
            <span class="label">Scaduto</span>
            <span class="value">${fmtEur(sum(overdue))}</span>
            <span class="sub">${overdue.length ? plural(overdue.length, 'rata scaduta', 'rate scadute') : 'nessuna rata scaduta'}</span>
          </div>
          <div class="card stat">
            <span class="label">Entro 30 giorni</span>
            <span class="value">${fmtEur(sum(soon))}</span>
            <span class="sub">${soon.length ? plural(soon.length, 'rata in arrivo', 'rate in arrivo') : 'nessuna in arrivo'}</span>
          </div>
        </div>
        ${
          plans.length
            ? plans.map(planCard).join('')
            : `<div class="card" style="margin-top:14px">${emptyState('Nessun piano di pagamento. Aggiungi le rate di un bollettino, ad esempio i lavori del condominio.')}</div>`
        }
        <p class="muted" style="font-size:.82rem;margin-top:10px">
          Qui non parte nessun addebito automatico: quando paghi un bollettino premi «Paga» sulla rata e si
          crea il movimento di spesa. All'apertura dell'app un avviso ti ricorda le rate scadute, finché non le registri.
          Se elimini il movimento, la rata torna da pagare.
        </p>
      </div>`);
    main.appendChild(page);

    bindFisseTabs(main);
    main.querySelector('#add-plan').addEventListener('click', () => openPlanModal(null, reload));
    const planOf = (el) => plans.find((p) => String(p.id) === el.closest('.plan-card').dataset.plan);
    const instOf = (el) => {
      const p = planOf(el);
      return { plan: p, inst: p.installments.find((i) => String(i.id) === el.closest('.inst-row')?.dataset.inst) };
    };

    // Sul contenitore della pagina (non su `main`, che resta lo stesso elemento tra un rendering e l'altro).
    page.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('show-moves')) return openPlanMovements(planOf(t));
      if (t.classList.contains('edit-pay')) {
        const { plan, inst } = instOf(t);
        try {
          const { transactions } = await api.transactions(`paymentPlanId=${plan.id}&limit=500`);
          const tx = transactions.find((x) => x.id === inst.transactionId);
          if (tx) openTxModal(tx, reload);
        } catch (ex) {
          toast(ex.message, 'error');
        }
        return;
      }
      if (t.classList.contains('edit-plan')) return openPlanModal(planOf(t), reload);
      if (t.classList.contains('add-inst')) return openInstModal(planOf(t), null, reload);
      if (t.classList.contains('equalize')) return openEqualizeModal(planOf(t), reload);
      if (t.classList.contains('edit-inst')) {
        const { plan, inst } = instOf(t);
        return openInstModal(plan, inst, reload);
      }
      if (t.classList.contains('pay-inst')) {
        const { plan, inst } = instOf(t);
        const item = { ...inst, planName: plan.name, accountId: plan.accountId };
        return openPayModal(item, reload);
      }
      if (t.classList.contains('del-inst')) {
        const { plan, inst } = instOf(t);
        const ok = await choiceModal({
          title: `Eliminare la rata ${inst.number}/${inst.total}?`,
          body: `<p>La rata del <strong>${dmy(inst.dueOn)}</strong> di ${fmtEur(inst.amount)} viene tolta dal piano «${escapeHtml(plan.name)}».</p>`,
          buttons: [
            { label: 'Elimina la rata', value: 'ok', kind: 'danger' },
            { label: 'Annulla', value: null, kind: 'ghost' },
          ],
        });
        if (ok !== 'ok') return;
        try {
          await api.del(`/api/payments/installments/${inst.id}`);
          toast('Rata eliminata');
          reload();
        } catch (ex) {
          toast(ex.message, 'error');
        }
        return;
      }
      if (t.classList.contains('undo-pay')) {
        const { plan, inst } = instOf(t);
        const ok = await choiceModal({
          title: 'Annullare il pagamento?',
          body: `<p>Il movimento di ${fmtEur(inst.paidAmount)} del ${dmy(inst.paidOn)} viene <strong>eliminato</strong> e la rata ${inst.number}/${inst.total} di «${escapeHtml(plan.name)}» torna da pagare.</p>`,
          buttons: [
            { label: 'Elimina il movimento', value: 'ok', kind: 'danger' },
            { label: 'Annulla', value: null, kind: 'ghost' },
          ],
        });
        if (ok !== 'ok') return;
        try {
          await api.del(`/api/transactions/${inst.transactionId}`);
          toast('Pagamento annullato');
          reload();
        } catch (ex) {
          toast(ex.message, 'error');
        }
        return;
      }
      if (t.classList.contains('del-plan')) {
        const plan = planOf(t);
        const paid = plan.progress.paidCount;
        const ok = await choiceModal({
          title: 'Eliminare il piano?',
          body: `<p>Il piano «${escapeHtml(plan.name)}» e le sue ${plural(plan.progress.total - paid, 'rata non pagata', 'rate non pagate')} vengono eliminati.</p>
                 <p>${paid ? `I <strong>${paid}</strong> movimenti già registrati restano nell'elenco.` : 'Nessun movimento viene toccato.'}</p>`,
          buttons: [
            { label: 'Elimina il piano', value: 'ok', kind: 'danger' },
            { label: 'Annulla', value: null, kind: 'ghost' },
          ],
        });
        if (ok !== 'ok') return;
        try {
          await api.del(`/api/payments/${plan.id}`);
          toast('Piano eliminato');
          reload();
        } catch (ex) {
          toast(ex.message, 'error');
        }
      }
    });
  }

  return { openPlanMovements, viewDaPagare, refreshDue, checkOnOpen, openDuePopup, dueCardHtml, bindDueCard, fisseTabsHtml, bindFisseTabs, openPayModal };
}
