import { api } from './api.js';
import { donut, bars, budgetBars, spark, fmtEur, escapeHtml } from './charts.js';
import { icons, logoMark } from './icons.js';

const root = document.getElementById('app');
const state = {
  user: null,
  view: 'dashboard',
  anchor: today(),
  period: 'month',
  scope: '',
  forecastYear: new Date().getUTCFullYear(),
  forecastIncludeRec: true,
};

const MONTHS_SHORT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
const MONTHS_LONG = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

// scope: '' = tutti, 'personal' = personali, 'home' = casa
const SCOPES = {
  personal: { label: 'Personale', short: 'Pers.', icon: () => icons.person },
  home: { label: 'Casa', short: 'Casa', icon: () => icons.home },
};
const ACCOUNT_KINDS = {
  bank: 'Conto corrente',
  cash: 'Contanti',
  card: 'Carta',
  savings: 'Risparmio',
  other: 'Altro',
};

/* ------------------------------------------------------------------ utils */
function today() {
  return new Date().toISOString().slice(0, 10);
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(dt) {
  return dt.toISOString().slice(0, 10);
}
function addDays(s, n) {
  const dt = parseISO(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISO(dt);
}
function startOfWeek(s) {
  const dt = parseISO(s);
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return toISO(dt);
}
function startOfMonth(s) {
  const dt = parseISO(s);
  return toISO(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)));
}
function endOfMonth(s) {
  const dt = parseISO(s);
  return toISO(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)));
}
const dtfDay = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const dtfMonth = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });
const dtfShort = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short' });

function periodRange(period, anchor) {
  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
}
function periodLabel(period, anchor) {
  const { from, to } = periodRange(period, anchor);
  if (period === 'day') return capitalize(dtfDay.format(parseISO(anchor)));
  if (period === 'week') return `${dtfShort.format(parseISO(from))} – ${dtfShort.format(parseISO(to))}`;
  return capitalize(dtfMonth.format(parseISO(anchor)));
}
function shiftPeriod(period, anchor, dir) {
  if (period === 'day') return addDays(anchor, dir);
  if (period === 'week') return addDays(anchor, dir * 7);
  const dt = parseISO(anchor);
  return toISO(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + dir, 1)));
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast'), 3000);
}

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const { user } = await api.me();
    state.user = user;
    renderShell();
  } catch {
    renderAuth();
  }
}

/* ------------------------------------------------------------------ auth */
async function renderAuth() {
  let registrationEnabled = true;
  try {
    ({ registrationEnabled } = await api.authConfig());
  } catch {
    /* keep default */
  }
  root.innerHTML = '';
  const view = h(`
    <div class="auth">
      <svg class="blob" width="520" height="520" viewBox="0 0 200 200" aria-hidden="true" style="top:-140px;left:-120px">
        <path fill="#6c8cff" d="M43 -61C55 -52 62 -37 66 -22C70 -6 70 11 63 24C56 37 42 46 27 54C11 62 -6 69 -21 65C-37 61 -50 46 -58 30C-66 13 -68 -6 -62 -22C-56 -38 -42 -50 -27 -59C-12 -68 4 -73 20 -71C35 -69 31 -70 43 -61Z" transform="translate(100 100)"/>
      </svg>
      <svg class="blob" width="420" height="420" viewBox="0 0 200 200" aria-hidden="true" style="bottom:-120px;right:-100px">
        <path fill="#12b886" d="M39 -56C50 -47 57 -33 62 -18C66 -3 68 14 61 27C55 40 41 47 26 55C11 62 -5 69 -20 65C-35 61 -48 45 -55 29C-63 12 -64 -7 -58 -23C-52 -39 -39 -51 -25 -59C-11 -67 5 -70 20 -68C34 -66 28 -65 39 -56Z" transform="translate(100 100)"/>
      </svg>
      <div class="auth-card">
        <div class="brand">${logoMark}<span>Soldi</span></div>
        <p class="tagline">Le tue spese ed entrate, in ordine.</p>
        <div class="auth-tabs" ${registrationEnabled ? '' : 'hidden'}>
          <button data-tab="login" class="active">Accedi</button>
          <button data-tab="register">Crea account</button>
        </div>
        <form id="auth-form"></form>
      </div>
    </div>
  `);
  root.appendChild(view);

  let tab = 'login';
  const form = view.querySelector('#auth-form');
  const renderForm = () => {
    form.innerHTML =
      (tab === 'register'
        ? `<div class="field"><label for="name">Nome</label><input id="name" name="displayName" autocomplete="name" placeholder="Come ti chiami" /></div>`
        : '') +
      `<div class="field">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" required autocomplete="email" placeholder="tu@esempio.it" />
       </div>
       <div class="field">
         <label for="password">Password</label>
         <input id="password" name="password" type="password" required minlength="8"
                autocomplete="${tab === 'register' ? 'new-password' : 'current-password'}"
                placeholder="Almeno 8 caratteri" />
         <span class="error" id="auth-err"></span>
       </div>
       <button class="btn primary" type="submit" style="width:100%;justify-content:center">
         ${tab === 'register' ? 'Crea account' : 'Accedi'}
       </button>`;
  };
  renderForm();

  view.querySelectorAll('.auth-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      view.querySelectorAll('.auth-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      renderForm();
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    const err = form.querySelector('#auth-err');
    err.textContent = '';
    btn.disabled = true;
    try {
      const { user } =
        tab === 'register'
          ? await api.register({ email: fd.email, password: fd.password, displayName: fd.displayName })
          : await api.login(fd.email, fd.password);
      state.user = user;
      location.hash = '#/dashboard';
      renderShell();
      toast(`Ciao ${user.displayName || ''}!`.trim());
    } catch (ex) {
      err.textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ shell */
const NAV = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home', icon: icons.dashboard },
  { id: 'movimenti', label: 'Movimenti', short: 'Movim.', icon: icons.list },
  { id: 'previsioni', label: 'Previsioni', short: 'Prev.', icon: icons.target },
  { id: 'fisse', label: 'Spese fisse', short: 'Fisse', icon: icons.repeat },
  { id: 'categorie', label: 'Categorie', short: 'Cat.', icon: icons.tag },
  { id: 'conti', label: 'Conti', icon: icons.bank },
  { id: 'impostazioni', label: 'Impostazioni', short: 'Impost.', icon: icons.settings },
];

function currentView() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  return NAV.some((n) => n.id === hash) ? hash : 'dashboard';
}

function renderShell() {
  state.view = currentView();
  root.innerHTML = '';
  const shell = h(`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">${logoMark}<span>Soldi</span></div>
        ${NAV.map(
          (n) => `<a class="nav-link ${n.id === state.view ? 'active' : ''}" href="#/${n.id}">${n.icon}<span>${n.label}</span></a>`
        ).join('')}
        <div class="nav-spacer"></div>
        <button class="nav-link" id="logout">${icons.logout}<span>Esci</span></button>
      </aside>
      <main class="main" id="main"></main>
      <nav class="tabbar">
        ${NAV.map(
          (n) => `<button data-view="${n.id}" class="${n.id === state.view ? 'active' : ''}">${n.icon}<span>${n.short || n.label}</span></button>`
        ).join('')}
      </nav>
      <button class="fab" id="fab" aria-label="Aggiungi movimento">${icons.plus}</button>
    </div>
  `);
  root.appendChild(shell);

  shell.querySelector('#logout').addEventListener('click', async () => {
    await api.logout();
    state.user = null;
    location.hash = '';
    renderAuth();
  });
  shell.querySelectorAll('.tabbar button').forEach((b) =>
    b.addEventListener('click', () => (location.hash = `#/${b.dataset.view}`))
  );
  shell.querySelector('#fab').addEventListener('click', () => openTxModal());

  renderView();
}

function renderView() {
  state.view = currentView();
  document.querySelectorAll('.nav-link').forEach((a) =>
    a.classList.toggle('active', a.getAttribute('href') === `#/${state.view}`)
  );
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view)
  );
  const main = document.getElementById('main');
  main.innerHTML = '<div class="boot"><div class="boot-mark"></div></div>';
  ({
    dashboard: viewDashboard,
    movimenti: viewMovimenti,
    previsioni: viewPrevisioni,
    fisse: viewSpeseFisse,
    categorie: viewCategorie,
    conti: viewConti,
    impostazioni: viewImpostazioni,
  }[state.view])(main);
}

/* ------------------------------------------------------------------ dashboard */
async function viewDashboard(main) {
  let data;
  try {
    const params = new URLSearchParams({ anchor: state.anchor });
    if (state.scope) params.set('scope', state.scope);
    data = await api.overview(params.toString());
  } catch (e) {
    main.innerHTML = `<div class="empty">Errore nel caricamento: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const p = state.period;
  const block = p === 'day' ? data.day : p === 'week' ? data.week : data.month;
  const trend =
    p === 'month'
      ? data.monthlyTrend.map((m) => ({
          label: capitalize(dtfMonth.format(parseISO(m.month + '-01')).split(' ')[0]).slice(0, 3),
          income: m.income,
          expense: m.expense,
        }))
      : data.dailyTrend.map((d) => ({ label: dtfShort.format(parseISO(d.date)).replace('.', ''), income: d.income, expense: d.expense }));

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div>
          <h1>Ciao ${escapeHtml(state.user.displayName || '')} 👋</h1>
          <p>Il tuo quadro finanziario</p>
        </div>
        <div class="segment" id="period-seg">
          <button data-p="day" class="${p === 'day' ? 'active' : ''}">Giorno</button>
          <button data-p="week" class="${p === 'week' ? 'active' : ''}">Settimana</button>
          <button data-p="month" class="${p === 'month' ? 'active' : ''}">Mese</button>
        </div>
      </div>

      <div class="dash-controls">
        <div class="segment scope-seg" id="scope-seg">
          <button data-s="" class="${state.scope === '' ? 'active' : ''}">Tutti</button>
          <button data-s="personal" class="${state.scope === 'personal' ? 'active' : ''}">${icons.person}Personale</button>
          <button data-s="home" class="${state.scope === 'home' ? 'active' : ''}">${icons.home}Casa</button>
        </div>
        <div class="period-nav">
          <button class="icon-btn" id="prev" aria-label="Periodo precedente">${icons.chevronL}</button>
          <span class="range">${escapeHtml(periodLabel(p, state.anchor))}</span>
          <button class="icon-btn" id="next" aria-label="Periodo successivo">${icons.chevronR}</button>
          <button class="btn ghost" id="today-btn">Oggi</button>
        </div>
      </div>

      <div class="hero ${block.net >= 0 ? 'pos' : 'neg'}">
        <div class="hero-bg" aria-hidden="true">${icons.wave}</div>
        <span class="hero-label">Saldo ${p === 'day' ? 'del giorno' : p === 'week' ? 'della settimana' : 'del mese'}</span>
        <span class="hero-value">${fmtEur(block.net)}</span>
        <div class="hero-chips">
          <span class="hero-chip up">${icons.arrowUp}Entrate ${fmtEur(block.income)}</span>
          <span class="hero-chip down">${icons.arrowDown}Uscite ${fmtEur(block.expense)}</span>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card stat income">
          <div class="stat-head"><span class="stat-ico">${icons.arrowUp}</span><span class="label">Entrate</span></div>
          <span class="value">${fmtEur(block.income)}</span>
          ${statSplit(block, 'income')}
          <div class="spark">${spark(trend.map((t) => t.income), { color: 'var(--income)' })}</div>
        </div>
        <div class="card stat expense">
          <div class="stat-head"><span class="stat-ico">${icons.arrowDown}</span><span class="label">Uscite</span></div>
          <span class="value">${fmtEur(block.expense)}</span>
          ${statSplit(block, 'expense')}
          <div class="spark">${spark(trend.map((t) => t.expense), { color: 'var(--expense)' })}</div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card card-pad chart-card">
          <h3>Spese per categoria</h3>
          <p class="hint">Mese di ${escapeHtml(capitalize(dtfMonth.format(parseISO(state.anchor))))}</p>
          <div class="donut-wrap">
            ${donut(data.expenseByCategory)}
            <div class="legend">
              ${
                data.expenseByCategory.length
                  ? data.expenseByCategory
                      .slice(0, 6)
                      .map(
                        (c) =>
                          `<div class="row"><span class="dot" style="background:${c.color}"></span>${escapeHtml(
                            c.name
                          )}<span class="amt">${fmtEur(c.total)}</span></div>`
                      )
                      .join('')
                  : '<span class="muted">Aggiungi una spesa per vedere la ripartizione.</span>'
              }
            </div>
          </div>
        </div>
        <div class="card card-pad chart-card">
          <h3>Andamento</h3>
          <p class="hint">${p === 'month' ? 'Ultimi 6 mesi' : 'Ultimi 30 giorni'} · <span style="color:var(--income)">entrate</span> / <span style="color:var(--expense)">uscite</span></p>
          ${bars(trend)}
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card card-pad chart-card">
          <h3>Personale vs Casa</h3>
          <p class="hint">Uscite del mese</p>
          ${scopeSplitBlock(data.scopeSplit)}
        </div>
        <div class="card card-pad chart-card">
          <h3>Spese per conto</h3>
          <p class="hint">Mese di ${escapeHtml(capitalize(dtfMonth.format(parseISO(state.anchor))))}</p>
          <div class="legend">
            ${
              (data.expenseByAccount || []).filter((x) => x.total > 0).length
                ? data.expenseByAccount
                    .filter((x) => x.total > 0)
                    .map(
                      (x) =>
                        `<div class="row"><span class="dot" style="background:${x.color}"></span>${escapeHtml(
                          x.name
                        )}<span class="amt">${fmtEur(x.total)}</span></div>`
                    )
                    .join('')
                : '<span class="muted">Assegna un conto ai movimenti per vedere questa ripartizione.</span>'
            }
          </div>
        </div>
      </div>

      <h2 class="section-title">Movimenti recenti</h2>
      <div class="card" id="recent"></div>
    </div>
  `)
  );

  main.querySelector('#scope-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.scope = b.dataset.s;
    viewDashboard(main);
  });

  main.querySelector('#period-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.period = b.dataset.p;
    viewDashboard(main);
  });
  main.querySelector('#prev').addEventListener('click', () => {
    state.anchor = shiftPeriod(state.period, state.anchor, -1);
    viewDashboard(main);
  });
  main.querySelector('#next').addEventListener('click', () => {
    state.anchor = shiftPeriod(state.period, state.anchor, 1);
    viewDashboard(main);
  });
  main.querySelector('#today-btn').addEventListener('click', () => {
    state.anchor = today();
    viewDashboard(main);
  });

  const { from, to } = periodRange(p, state.anchor);
  const recentQs = new URLSearchParams({ from, to, limit: '8' });
  if (state.scope) recentQs.set('scope', state.scope);
  const { transactions } = await api.transactions(recentQs.toString());
  const recent = main.querySelector('#recent');
  recent.innerHTML =
    transactions.length === 0
      ? emptyState('Nessun movimento in questo periodo.')
      : transactions.map(txRow).join('');
  bindTxRows(recent, () => viewDashboard(main));
}

/* ------------------------------------------------------------------ movimenti */
async function viewMovimenti(main) {
  const [{ categories }, { accounts }] = await Promise.all([api.categories(), api.accounts()]);
  state._categories = categories;
  state._accounts = accounts;
  const filters =
    state._txFilters || { type: '', categoryId: '', accountId: '', scope: '', month: startOfMonth(today()) };
  state._txFilters = filters;

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Movimenti</h1><p>Tutte le entrate e le uscite</p></div>
        <button class="btn primary" id="add-tx">${icons.plus}<span>Aggiungi</span></button>
      </div>
      <div class="list-head">
        <div class="filters">
          <select id="f-month">
            ${monthOptions(filters.month)}
          </select>
          <select id="f-type">
            <option value="">Tutti i tipi</option>
            <option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>Uscite</option>
            <option value="income" ${filters.type === 'income' ? 'selected' : ''}>Entrate</option>
          </select>
          <select id="f-cat">
            <option value="">Tutte le categorie</option>
            ${categories
              .map((c) => `<option value="${c.id}" ${String(filters.categoryId) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
              .join('')}
          </select>
          <select id="f-acc">
            <option value="">Tutti i conti</option>
            ${accounts
              .map((a) => `<option value="${a.id}" ${String(filters.accountId) === String(a.id) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
              .join('')}
          </select>
          <select id="f-scope">
            <option value="">Personale + Casa</option>
            <option value="personal" ${filters.scope === 'personal' ? 'selected' : ''}>Solo personale</option>
            <option value="home" ${filters.scope === 'home' ? 'selected' : ''}>Solo casa</option>
          </select>
        </div>
      </div>
      <div id="tx-list"></div>
    </div>
  `)
  );

  main.querySelector('#add-tx').addEventListener('click', () => openTxModal(null, () => viewMovimenti(main)));
  const reload = () => loadTxList(main);
  main.querySelector('#f-month').addEventListener('change', (e) => { filters.month = e.target.value; reload(); });
  main.querySelector('#f-type').addEventListener('change', (e) => { filters.type = e.target.value; reload(); });
  main.querySelector('#f-cat').addEventListener('change', (e) => { filters.categoryId = e.target.value; reload(); });
  main.querySelector('#f-acc').addEventListener('change', (e) => { filters.accountId = e.target.value; reload(); });
  main.querySelector('#f-scope').addEventListener('change', (e) => { filters.scope = e.target.value; reload(); });

  loadTxList(main);
}

async function loadTxList(main) {
  const f = state._txFilters;
  const from = f.month;
  const to = endOfMonth(f.month);
  const qs = new URLSearchParams({ from, to, limit: '500' });
  if (f.type) qs.set('type', f.type);
  if (f.categoryId) qs.set('categoryId', f.categoryId);
  if (f.accountId) qs.set('accountId', f.accountId);
  if (f.scope) qs.set('scope', f.scope);

  const list = main.querySelector('#tx-list');
  list.innerHTML = '<div class="boot"><div class="boot-mark"></div></div>';
  const { transactions } = await api.transactions(qs.toString());

  if (transactions.length === 0) {
    list.innerHTML = emptyState('Nessun movimento con questi filtri.');
    return;
  }

  const totals = transactions.reduce(
    (a, t) => {
      a[t.type] += t.amount;
      return a;
    },
    { income: 0, expense: 0 }
  );

  const byDay = groupBy(transactions, (t) => t.occurredOn);
  list.innerHTML =
    `<div class="card card-pad" style="display:flex;gap:20px;margin-bottom:16px">
       <div><span class="label muted" style="font-size:.75rem">ENTRATE</span><div style="color:var(--income);font-weight:700">${fmtEur(totals.income)}</div></div>
       <div><span class="label muted" style="font-size:.75rem">USCITE</span><div style="color:var(--expense);font-weight:700">${fmtEur(totals.expense)}</div></div>
       <div><span class="label muted" style="font-size:.75rem">SALDO</span><div style="font-weight:700">${fmtEur(totals.income - totals.expense)}</div></div>
     </div>` +
    Object.entries(byDay)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(
        ([day, items]) => `
        <div class="tx-day">
          <div class="tx-day-head">
            <span>${escapeHtml(capitalize(dtfDay.format(parseISO(day))))}</span>
            <span>${fmtEur(items.reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0))}</span>
          </div>
          <div class="card">${items.map(txRow).join('')}</div>
        </div>`
      )
      .join('');

  bindTxRows(list, () => loadTxList(main));
}

/* ------------------------------------------------------------------ categorie */
async function viewCategorie(main) {
  const { categories } = await api.categories();
  state._categories = null; // drop modal cache; it will refetch
  const groups = {
    expense: { personal: [], home: [] },
    income: { personal: [], home: [] },
  };
  categories.forEach((c) => groups[c.kind][c.scope].push(c));

  const catRow = (c) => `
    <div class="cat-row" data-id="${c.id}">
      <span class="dot" style="background:${c.color}"></span>
      <span class="name meta">${escapeHtml(c.name)}</span>
      <div class="row-tail">
        <span class="count">${c.tx_count} mov.</span>
        <button class="icon-btn edit-cat" aria-label="Modifica">${icons.edit}</button>
        <button class="icon-btn del-cat" aria-label="Elimina">${icons.trash}</button>
      </div>
    </div>`;

  const scopeGroup = (list, icon, label) => `
    <div class="scope-group">
      <h3 class="scope-group-title">${icon}${label}</h3>
      <div class="card">
        ${list.length ? list.map(catRow).join('') : '<div class="cat-row muted">Nessuna categoria</div>'}
      </div>
    </div>`;

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Categorie</h1><p>Organizza spese ed entrate, separate per ambito</p></div>
        <button class="btn primary" id="add-cat">${icons.plus}<span>Nuova</span></button>
      </div>
      ${['expense', 'income']
        .map(
          (kind) => `
        <h2 class="section-title">${kind === 'expense' ? 'Spese' : 'Entrate'}</h2>
        <div class="grid cols-2" style="margin-bottom:8px">
          ${scopeGroup(groups[kind].personal, icons.person, 'Personali')}
          ${scopeGroup(groups[kind].home, icons.home, 'Casa')}
        </div>`
        )
        .join('')}
    </div>
  `)
  );

  main.querySelector('#add-cat').addEventListener('click', () => openCatModal(null, () => viewCategorie(main)));
  main.querySelectorAll('.edit-cat').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.closest('.cat-row').dataset.id;
      openCatModal(categories.find((c) => String(c.id) === id), () => viewCategorie(main));
    })
  );
  main.querySelectorAll('.del-cat').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.cat-row').dataset.id;
      if (!confirm('Eliminare questa categoria? I movimenti collegati restano, senza categoria.')) return;
      try {
        await api.del(`/api/categories/${id}`);
        toast('Categoria eliminata');
        viewCategorie(main);
      } catch (e) {
        toast(e.message, 'error');
      }
    })
  );
}

/* ------------------------------------------------------------------ spese fisse */
async function viewSpeseFisse(main) {
  const [{ rules }, { categories }, { accounts }] = await Promise.all([
    api.recurring(),
    api.categories(),
    api.accounts(),
  ]);
  state._categories = categories;
  state._accounts = accounts;

  const active = rules.filter((r) => r.active);
  // Le regole annuali contano per 1/12 del loro importo, per una stima "al mese" coerente.
  const monthlyEquivalent = (r) => (r.cadence === 'monthly' ? r.amount : r.amount / 12);
  const monthlyExpense = active.filter((r) => r.type === 'expense').reduce((s, r) => s + monthlyEquivalent(r), 0);
  const monthlyIncome = active.filter((r) => r.type === 'income').reduce((s, r) => s + monthlyEquivalent(r), 0);

  const ruleRow = (r) => `
    <div class="cat-row ${r.active ? '' : 'is-off'}" data-id="${r.id}">
      <span class="dot" style="background:${r.categoryColor || 'var(--brand)'}"></span>
      <div class="meta">
        <div class="name">${escapeHtml(r.name)} ${scopeBadge(r.scope)}</div>
        <div class="cat">${
          r.cadence === 'monthly'
            ? 'ogni mese, il ' + r.dayOfMonth
            : 'ogni anno a ' + MONTHS_LONG[(r.month || 1) - 1] + ', il ' + r.dayOfMonth
        }${r.categoryName ? ' · ' + escapeHtml(r.categoryName) : ''}${
          r.accountName ? ' · ' + escapeHtml(r.accountName) : ''
        }</div>
      </div>
      <div class="row-tail">
        <span class="amount ${r.type}">${r.type === 'income' ? '+' : '−'}${fmtEur(r.amount)}</span>
        <label class="switch" title="${r.active ? 'Attiva' : 'Disattivata'}">
          <input type="checkbox" class="rec-toggle" ${r.active ? 'checked' : ''} />
          <span class="switch-track"></span>
        </label>
        <button class="icon-btn edit-rec" aria-label="Modifica">${icons.edit}</button>
        <button class="icon-btn del-rec" aria-label="Elimina">${icons.trash}</button>
      </div>
    </div>`;

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Spese fisse</h1><p>Movimenti ricorrenti aggiunti automaticamente ogni mese</p></div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost" id="run-rec">${icons.play}<span>Esegui adesso</span></button>
          <button class="btn primary" id="add-rec">${icons.plus}<span>Nuova</span></button>
        </div>
      </div>

      <div class="grid cols-2" style="margin-bottom:6px">
        <div class="card stat expense">
          <span class="label">Uscite fisse / mese</span>
          <span class="value">${fmtEur(monthlyExpense)}</span>
          <span class="sub">${active.filter((r) => r.type === 'expense').length} attive</span>
        </div>
        <div class="card stat income">
          <span class="label">Entrate fisse / mese</span>
          <span class="value">${fmtEur(monthlyIncome)}</span>
          <span class="sub">${active.filter((r) => r.type === 'income').length} attive</span>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        ${
          rules.length
            ? rules.map(ruleRow).join('')
            : emptyState('Nessuna spesa fissa. Aggiungi mutuo, finanziamento, abbonamento…')
        }
      </div>
      <p class="muted" style="font-size:.82rem;margin-top:10px">
        Ogni regola crea un movimento — ogni mese, o una volta l'anno nel mese scelto — il giorno
        indicato, finché è attiva. Disattivandola smette senza cancellare lo storico. I movimenti
        generati hanno il badge «fissa».
      </p>
    </div>
  `)
  );

  main.querySelector('#add-rec').addEventListener('click', () => openRecurringModal(null, () => viewSpeseFisse(main)));
  main.querySelector('#run-rec').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api.runRecurring();
      toast(r.created > 0 ? `${r.created} movimenti generati` : 'Tutto già aggiornato');
      viewSpeseFisse(main);
    } catch (ex) {
      toast(ex.message, 'error');
      e.currentTarget.disabled = false;
    }
  });
  main.querySelectorAll('.rec-toggle').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const id = cb.closest('.cat-row').dataset.id;
      try {
        const r = await api.patch(`/api/recurring/${id}`, { active: cb.checked });
        toast(
          cb.checked
            ? r.generated > 0
              ? `Riattivata · ${r.generated} movimenti generati`
              : 'Riattivata'
            : 'Disattivata'
        );
        viewSpeseFisse(main);
      } catch (ex) {
        toast(ex.message, 'error');
        cb.checked = !cb.checked;
      }
    })
  );
  main.querySelectorAll('.edit-rec').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.closest('.cat-row').dataset.id;
      openRecurringModal(rules.find((r) => String(r.id) === id), () => viewSpeseFisse(main));
    })
  );
  main.querySelectorAll('.del-rec').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.cat-row').dataset.id;
      const keep = confirm(
        'Eliminare questa spesa fissa?\n\nOK = elimina anche i movimenti già generati\nAnnulla = tieni la regola'
      );
      if (!keep) return;
      const alsoKeepMov = confirm('Vuoi CONSERVARE i movimenti già generati? (Annulla = eliminali)');
      try {
        await api.del(`/api/recurring/${id}?keepMovimenti=${alsoKeepMov ? 'true' : 'false'}`);
        toast('Spesa fissa eliminata');
        viewSpeseFisse(main);
      } catch (ex) {
        toast(ex.message, 'error');
      }
    })
  );
}

async function openRecurringModal(rule = null, onChange) {
  const cats = state._categories || (await api.categories()).categories;
  const accounts = state._accounts || (await api.accounts()).accounts;
  state._categories = cats;
  state._accounts = accounts;
  const editing = !!rule;
  const r = rule || {
    name: '',
    type: 'expense',
    amount: '',
    categoryId: cats.find((c) => c.kind === 'expense' && c.scope === 'personal')?.id,
    accountId: accounts[0]?.id ?? null,
    scope: 'personal',
    cadence: 'monthly',
    month: new Date().getUTCMonth() + 1,
    dayOfMonth: 1,
    note: '',
    active: true,
  };

  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica spesa fissa' : 'Nuova spesa fissa'}</h2>
    <form id="rec-form">
      <div class="field">
        <label for="rname">Nome</label>
        <input id="rname" name="name" required maxlength="80" value="${escapeHtml(r.name)}"
               placeholder="Es. Mutuo casa, Rata auto, Netflix" />
      </div>
      <div class="segment" id="rtype-seg" style="margin-bottom:14px">
        <button type="button" data-t="expense" class="${r.type === 'expense' ? 'active' : ''}">Uscita</button>
        <button type="button" data-t="income" class="${r.type === 'income' ? 'active' : ''}">Entrata</button>
      </div>
      <div class="segment" id="rcad-seg" style="margin-bottom:14px">
        <button type="button" data-c="monthly" class="${r.cadence === 'monthly' ? 'active' : ''}">Ogni mese</button>
        <button type="button" data-c="yearly" class="${r.cadence === 'yearly' ? 'active' : ''}">Una volta l'anno</button>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="ramount">Importo (€)</label>
          <input id="ramount" name="amount" type="number" step="0.01" min="0.01" required
                 inputmode="decimal" value="${r.amount || ''}" />
        </div>
        <div class="field">
          <label for="rday">Giorno del mese</label>
          <input id="rday" name="dayOfMonth" type="number" min="1" max="28" required value="${r.dayOfMonth}" />
        </div>
      </div>
      <div class="field" id="rmonth-field" ${r.cadence === 'yearly' ? '' : 'hidden'}>
        <label for="rmonth">Mese</label>
        <select id="rmonth" name="month">
          ${MONTHS_LONG.map(
            (m, i) => `<option value="${i + 1}" ${r.month === i + 1 ? 'selected' : ''}>${capitalize(m)}</option>`
          ).join('')}
        </select>
      </div>
      ${catField('rcat', 'Categoria', 'categoryId')}
      <div class="field">
        <label for="racc">Conto</label>
        <select id="racc" name="accountId">
          <option value="">Nessun conto</option>
          ${accounts
            .map(
              (acc) =>
                `<option value="${acc.id}" ${String(acc.id) === String(r.accountId) ? 'selected' : ''}>${escapeHtml(acc.name)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="field">
        <label>Ambito</label>
        <label class="switch-row">
          <span class="switch-label personal ${r.scope === 'personal' ? 'on' : ''}">${icons.person}Personale</span>
          <span class="switch">
            <input type="checkbox" id="rscope" ${r.scope === 'home' ? 'checked' : ''} />
            <span class="switch-track"></span>
          </span>
          <span class="switch-label home ${r.scope === 'home' ? 'on' : ''}">${icons.home}Casa</span>
        </label>
      </div>
      <div class="field">
        <label for="rnote">Nota</label>
        <input id="rnote" name="note" maxlength="280" value="${escapeHtml(r.note || '')}" placeholder="Facoltativa" />
      </div>
      <label class="switch-row" style="margin-bottom:4px">
        <span class="switch">
          <input type="checkbox" id="ractive" ${r.active ? 'checked' : ''} />
          <span class="switch-track"></span>
        </span>
        <span class="switch-label on">Attiva</span>
      </label>
      <span class="error" id="rec-err"></span>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="rec-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Crea'}</button>
      </div>
    </form>
  `);

  const form = bd.querySelector('#rec-form');
  let type = r.type;
  let scope = r.scope;
  let cadence = r.cadence;
  const catSel = form.querySelector('#rcat');
  const fillCats = (sel = r.categoryId) => {
    const opts = cats.filter((c) => c.kind === type && c.scope === scope);
    catSel.innerHTML =
      '<option value="">Senza categoria</option>' +
      opts
        .map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
        .join('');
  };
  fillCats();
  wireQuickCat(form, { selectId: 'rcat', cats, getKind: () => type, getScope: () => scope, refill: fillCats });

  form.querySelector('#rtype-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    type = b.dataset.t;
    form.querySelectorAll('#rtype-seg button').forEach((x) => x.classList.toggle('active', x === b));
    fillCats(catSel.value || r.categoryId);
  });

  form.querySelector('#rcad-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cadence = b.dataset.c;
    form.querySelectorAll('#rcad-seg button').forEach((x) => x.classList.toggle('active', x === b));
    form.querySelector('#rmonth-field').hidden = cadence !== 'yearly';
  });

  const scopeInput = form.querySelector('#rscope');
  scopeInput.addEventListener('change', () => {
    scope = scopeInput.checked ? 'home' : 'personal';
    form.querySelector('.switch-label.personal').classList.toggle('on', scope === 'personal');
    form.querySelector('.switch-label.home').classList.toggle('on', scope === 'home');
    fillCats(catSel.value || r.categoryId);
  });

  form.querySelector('#rec-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = {
      name: fd.name,
      type,
      amount: Number(fd.amount),
      cadence,
      month: cadence === 'yearly' ? Number(fd.month) : null,
      dayOfMonth: Number(fd.dayOfMonth),
      categoryId: fd.categoryId ? Number(fd.categoryId) : null,
      accountId: fd.accountId ? Number(fd.accountId) : null,
      scope,
      note: fd.note || '',
      active: form.querySelector('#ractive').checked,
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = editing
        ? await api.patch(`/api/recurring/${rule.id}`, body)
        : await api.post('/api/recurring', body);
      close();
      const g = res.generated || 0;
      toast(
        (editing ? 'Spesa fissa aggiornata' : 'Spesa fissa creata') +
          (g > 0 ? ` · ${g} movimenti generati` : '')
      );
      onChange?.();
    } catch (ex) {
      form.querySelector('#rec-err').textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ previsioni */
async function viewPrevisioni(main) {
  const y = state.forecastYear;
  const qs = new URLSearchParams({ year: y, includeRecurring: state.forecastIncludeRec });
  if (state.scope) qs.set('scope', state.scope);

  let sum, planned;
  try {
    [sum, { planned }] = await Promise.all([api.plannedSummary(qs.toString()), api.planned()]);
  } catch (e) {
    main.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  state._categories = null;

  const overBudget = sum.projectedYearEnd > sum.totalPlanned + 0.005;
  const monthsForChart = sum.months.map((m) => ({
    label: MONTHS_SHORT[m.month - 1],
    planned: m.planned,
    actual: m.actual,
  }));

  const catRows = sum.byCategory
    .filter((c) => c.planned > 0 || c.actual > 0)
    .map((c) => {
      const pct = c.planned > 0 ? Math.min(150, Math.round((c.actual / c.planned) * 100)) : 0;
      const over = c.planned > 0 && c.actual > c.planned + 0.005;
      return `
        <div class="cat-row">
          <span class="dot" style="background:${c.color}"></span>
          <div class="meta">
            <div class="name">${escapeHtml(c.name)}</div>
            <div class="budget-bar"><span style="width:${Math.min(100, pct)}%;background:${
              over ? 'var(--expense)' : 'var(--accent)'
            }"></span></div>
          </div>
          <div class="row-tail" style="text-align:right;white-space:nowrap;display:block">
            <div style="font-weight:700;font-variant-numeric:tabular-nums">${fmtEur(c.actual)}</div>
            <div class="count">/ ${c.planned > 0 ? fmtEur(c.planned) : '—'}</div>
          </div>
        </div>`;
    })
    .join('');

  const itemRow = (p) => `
    <div class="cat-row ${p.active ? '' : 'is-off'}" data-id="${p.id}">
      <span class="dot" style="background:${p.categoryColor || 'var(--brand)'}"></span>
      <div class="meta">
        <div class="name">${escapeHtml(p.name)} ${scopeBadge(p.scope)}</div>
        <div class="cat">${fmtEur(p.amount)}${p.cadence === 'monthly' ? '/mese' : '/anno'} · ${
          p.cadence === 'monthly' ? 'ogni mese' : 'a ' + MONTHS_LONG[(p.month || 1) - 1]
        }${p.categoryName ? ' · ' + escapeHtml(p.categoryName) : ''}</div>
      </div>
      <div class="row-tail">
        <label class="switch" title="${p.active ? 'Attiva' : 'Disattivata'}">
          <input type="checkbox" class="pl-toggle" ${p.active ? 'checked' : ''} />
          <span class="switch-track"></span>
        </label>
        <button class="icon-btn edit-pl" aria-label="Modifica">${icons.edit}</button>
        <button class="icon-btn del-pl" aria-label="Elimina">${icons.trash}</button>
      </div>
    </div>`;

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Previsioni</h1><p>Budget e proiezione delle spese annuali</p></div>
        <button class="btn primary" id="add-pl">${icons.plus}<span>Nuova voce</span></button>
      </div>

      <div class="period-nav" style="margin-bottom:14px">
        <button class="icon-btn" id="y-prev" aria-label="Anno precedente">${icons.chevronL}</button>
        <span class="range" style="min-width:90px">${y}</span>
        <button class="icon-btn" id="y-next" aria-label="Anno successivo">${icons.chevronR}</button>
        <label class="switch-row" style="margin-left:14px">
          <span class="switch">
            <input type="checkbox" id="inc-rec" ${state.forecastIncludeRec ? 'checked' : ''} />
            <span class="switch-track"></span>
          </span>
          <span class="switch-label ${state.forecastIncludeRec ? 'on' : ''}">Includi spese fisse</span>
        </label>
      </div>

      <div class="grid cols-3">
        <div class="card stat">
          <span class="label">Totale previsto ${y}</span>
          <span class="value">${fmtEur(sum.totalPlanned)}</span>
          <span class="sub">${state.forecastIncludeRec ? 'incl. spese fisse' : 'solo spese previste'}</span>
        </div>
        <div class="card stat expense">
          <span class="label">Speso ${y}</span>
          <span class="value">${fmtEur(sum.totalActual)}</span>
          <span class="sub">movimenti reali</span>
        </div>
        <div class="card stat">
          <span class="label">Proiezione fine ${y}</span>
          <span class="value" style="color:${overBudget ? 'var(--expense)' : 'var(--income)'}">${fmtEur(sum.projectedYearEnd)}</span>
          <span class="sub">${
            overBudget
              ? '+' + fmtEur(sum.projectedYearEnd - sum.totalPlanned) + ' sopra il budget'
              : fmtEur(sum.totalPlanned - sum.projectedYearEnd) + ' sotto il budget'
          }</span>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card stat">
          <span class="label">Budget mensile necessario</span>
          <span class="value">${fmtEur(sum.monthlyBudgetNeed)}</span>
          <span class="sub">spese previste ${y} ÷ 12 (incl. voci annuali smussate)</span>
        </div>
        <div class="card stat">
          <span class="label">Risparmio potenziale / mese</span>
          <span class="value" style="color:${
            sum.potentialMonthlySavings == null
              ? 'inherit'
              : sum.potentialMonthlySavings >= 0
                ? 'var(--income)'
                : 'var(--expense)'
          }">${sum.potentialMonthlySavings == null ? '—' : fmtEur(sum.potentialMonthlySavings)}</span>
          <span class="sub">${
            sum.avgMonthlyIncome == null
              ? 'servono entrate registrate quest\'anno'
              : 'entrate medie ' + fmtEur(sum.avgMonthlyIncome) + '/mese − budget necessario'
          }</span>
        </div>
      </div>

      <div class="card card-pad chart-card" style="margin-top:16px">
        <h3>Previsto contro speso</h3>
        <p class="hint">Per mese · <span style="color:var(--brand)">previsto</span> / <span style="color:var(--accent)">speso</span></p>
        ${budgetBars(monthsForChart)}
      </div>

      <h2 class="section-title">Per categoria</h2>
      <div class="card">${catRows || emptyState('Aggiungi voci previste per vedere il confronto.')}</div>

      <h2 class="section-title">Voci previste</h2>
      <div class="card" id="pl-list">
        ${planned.length ? planned.map(itemRow).join('') : emptyState('Nessuna voce. Aggiungi affitto, assicurazioni, tasse, spesa media…')}
      </div>
      <p class="muted" style="font-size:.82rem;margin-top:10px">
        Le voci previste sono assunzioni di budget: <strong>non creano movimenti</strong> e non
        influenzano i grafici della Dashboard. Le <strong>spese fisse</strong> già create possono
        essere incluse nella previsione con l'interruttore qui sopra. Il «budget mensile
        necessario» divide per 12 il totale previsto dell'anno, così le spese annuali (es.
        bollo auto) vengono spalmate su ogni mese; il «risparmio potenziale» lo confronta con
        le entrate reali medie dei mesi già trascorsi.
      </p>
    </div>
  `)
  );

  main.querySelector('#y-prev').addEventListener('click', () => {
    state.forecastYear--;
    viewPrevisioni(main);
  });
  main.querySelector('#y-next').addEventListener('click', () => {
    state.forecastYear++;
    viewPrevisioni(main);
  });
  main.querySelector('#inc-rec').addEventListener('change', (e) => {
    state.forecastIncludeRec = e.target.checked;
    viewPrevisioni(main);
  });
  main.querySelector('#add-pl').addEventListener('click', () => openPlannedModal(null, () => viewPrevisioni(main)));
  main.querySelectorAll('.pl-toggle').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const id = cb.closest('.cat-row').dataset.id;
      try {
        await api.patch(`/api/planned/${id}`, { active: cb.checked });
        viewPrevisioni(main);
      } catch (ex) {
        toast(ex.message, 'error');
        cb.checked = !cb.checked;
      }
    })
  );
  main.querySelectorAll('.edit-pl').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.closest('.cat-row').dataset.id;
      openPlannedModal(planned.find((p) => String(p.id) === id), () => viewPrevisioni(main));
    })
  );
  main.querySelectorAll('.del-pl').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.cat-row').dataset.id;
      if (!confirm('Eliminare questa voce prevista?')) return;
      try {
        await api.del(`/api/planned/${id}`);
        toast('Voce eliminata');
        viewPrevisioni(main);
      } catch (ex) {
        toast(ex.message, 'error');
      }
    })
  );
}

async function openPlannedModal(item = null, onChange) {
  const cats = state._categories || (await api.categories()).categories;
  state._categories = cats;
  const editing = !!item;
  const p = item || {
    name: '',
    amount: '',
    categoryId: cats.find((c) => c.kind === 'expense' && c.scope === 'personal')?.id,
    scope: 'personal',
    cadence: 'monthly',
    month: new Date().getUTCMonth() + 1,
    note: '',
    active: true,
  };

  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica voce prevista' : 'Nuova voce prevista'}</h2>
    <form id="pl-form">
      <div class="field">
        <label for="pname">Nome</label>
        <input id="pname" name="name" required maxlength="80" value="${escapeHtml(p.name)}"
               placeholder="Es. Affitto, Assicurazione auto, Tasse" />
      </div>
      <div class="segment" id="pcad-seg" style="margin-bottom:14px">
        <button type="button" data-c="monthly" class="${p.cadence === 'monthly' ? 'active' : ''}">Ogni mese</button>
        <button type="button" data-c="yearly" class="${p.cadence === 'yearly' ? 'active' : ''}">Una volta l'anno</button>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="pamount">Importo (€)</label>
          <input id="pamount" name="amount" type="number" step="0.01" min="0.01" required
                 inputmode="decimal" value="${p.amount || ''}" />
        </div>
        <div class="field" id="pmonth-field" ${p.cadence === 'yearly' ? '' : 'hidden'}>
          <label for="pmonth">Mese</label>
          <select id="pmonth" name="month">
            ${MONTHS_LONG.map(
              (m, i) => `<option value="${i + 1}" ${p.month === i + 1 ? 'selected' : ''}>${capitalize(m)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      ${catField('pcat', 'Categoria', 'categoryId')}
      <div class="field">
        <label>Ambito</label>
        <label class="switch-row">
          <span class="switch-label personal ${p.scope === 'personal' ? 'on' : ''}">${icons.person}Personale</span>
          <span class="switch">
            <input type="checkbox" id="pscope" ${p.scope === 'home' ? 'checked' : ''} />
            <span class="switch-track"></span>
          </span>
          <span class="switch-label home ${p.scope === 'home' ? 'on' : ''}">${icons.home}Casa</span>
        </label>
      </div>
      <div class="field">
        <label for="pnote">Nota</label>
        <input id="pnote" name="note" maxlength="280" value="${escapeHtml(p.note || '')}" placeholder="Facoltativa" />
      </div>
      <label class="switch-row" style="margin-bottom:4px">
        <span class="switch">
          <input type="checkbox" id="pactive" ${p.active ? 'checked' : ''} />
          <span class="switch-track"></span>
        </span>
        <span class="switch-label on">Attiva</span>
      </label>
      <span class="error" id="pl-err"></span>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="pl-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Crea'}</button>
      </div>
    </form>
  `);

  const form = bd.querySelector('#pl-form');
  let cadence = p.cadence;
  let scope = p.scope;
  const pcat = form.querySelector('#pcat');
  const fillCats = (sel = p.categoryId) => {
    pcat.innerHTML =
      '<option value="">Senza categoria</option>' +
      cats
        .filter((c) => c.kind === 'expense' && c.scope === scope)
        .map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
        .join('');
  };
  fillCats();
  wireQuickCat(form, { selectId: 'pcat', cats, getKind: () => 'expense', getScope: () => scope, refill: fillCats });

  form.querySelector('#pcad-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cadence = b.dataset.c;
    form.querySelectorAll('#pcad-seg button').forEach((x) => x.classList.toggle('active', x === b));
    form.querySelector('#pmonth-field').hidden = cadence !== 'yearly';
  });

  const scopeInput = form.querySelector('#pscope');
  scopeInput.addEventListener('change', () => {
    scope = scopeInput.checked ? 'home' : 'personal';
    form.querySelector('.switch-label.personal').classList.toggle('on', scope === 'personal');
    form.querySelector('.switch-label.home').classList.toggle('on', scope === 'home');
    fillCats(pcat.value || p.categoryId);
  });

  form.querySelector('#pl-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = {
      name: fd.name,
      amount: Number(fd.amount),
      cadence,
      month: cadence === 'yearly' ? Number(fd.month) : null,
      categoryId: fd.categoryId ? Number(fd.categoryId) : null,
      scope,
      note: fd.note || '',
      active: form.querySelector('#pactive').checked,
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api.patch(`/api/planned/${item.id}`, body);
      else await api.post('/api/planned', body);
      close();
      toast(editing ? 'Voce aggiornata' : 'Voce creata');
      onChange?.();
    } catch (ex) {
      form.querySelector('#pl-err').textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ conti */
async function viewConti(main) {
  const { accounts } = await api.accounts();
  state._accounts = null; // drop modal cache; it will refetch

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Conti</h1><p>Da associare ai movimenti, come le categorie</p></div>
        <button class="btn primary" id="add-acc">${icons.plus}<span>Nuovo</span></button>
      </div>
      <div class="card">
        ${
          accounts.length
            ? accounts
                .map(
                  (acc) => `
          <div class="cat-row" data-id="${acc.id}">
            <span class="dot" style="background:${acc.color}"></span>
            <div class="meta">
              <span class="name">${escapeHtml(acc.name)}</span>
              <span class="pill">${escapeHtml(ACCOUNT_KINDS[acc.kind] || acc.kind)}</span>
            </div>
            <div class="row-tail">
              <span class="count">${acc.tx_count} mov.</span>
              <button class="icon-btn edit-acc" aria-label="Modifica">${icons.edit}</button>
              <button class="icon-btn del-acc" aria-label="Elimina">${icons.trash}</button>
            </div>
          </div>`
                )
                .join('')
            : emptyState('Nessun conto. Creane uno (es. «Contanti», «Conto corrente»).')
        }
      </div>
    </div>
  `)
  );

  main.querySelector('#add-acc').addEventListener('click', () => openAccountModal(null, () => viewConti(main)));
  main.querySelectorAll('.edit-acc').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.closest('.cat-row').dataset.id;
      openAccountModal(accounts.find((a) => String(a.id) === id), () => viewConti(main));
    })
  );
  main.querySelectorAll('.del-acc').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.cat-row').dataset.id;
      if (!confirm('Eliminare questo conto? I movimenti collegati restano, senza conto.')) return;
      try {
        await api.del(`/api/accounts/${id}`);
        toast('Conto eliminato');
        viewConti(main);
      } catch (e) {
        toast(e.message, 'error');
      }
    })
  );
}

function openAccountModal(acc = null, onChange) {
  const editing = !!acc;
  const a = acc || { name: '', kind: 'bank', color: '#6c8cff' };
  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica conto' : 'Nuovo conto'}</h2>
    <form id="acc-form">
      <div class="field">
        <label for="aname">Nome</label>
        <input id="aname" name="name" required maxlength="60" value="${escapeHtml(a.name)}" placeholder="Es. Conto corrente" />
      </div>
      <div class="row-2">
        <div class="field">
          <label for="akind">Tipo</label>
          <select id="akind" name="kind">
            ${Object.entries(ACCOUNT_KINDS)
              .map(([v, l]) => `<option value="${v}" ${a.kind === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="acolor">Colore</label>
          <input id="acolor" name="color" type="color" value="${a.color}" style="height:44px;padding:4px" />
        </div>
      </div>
      <span class="error" id="acc-err"></span>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="acc-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Crea'}</button>
      </div>
    </form>
  `);
  const form = bd.querySelector('#acc-form');
  form.querySelector('#acc-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api.patch(`/api/accounts/${acc.id}`, { name: fd.name, kind: fd.kind, color: fd.color });
      else await api.post('/api/accounts', { name: fd.name, kind: fd.kind, color: fd.color });
      close();
      toast(editing ? 'Conto aggiornato' : 'Conto creato');
      onChange?.();
    } catch (ex) {
      form.querySelector('#acc-err').textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ impostazioni */
async function viewImpostazioni(main) {
  let payload, version;
  try {
    [payload, version] = await Promise.all([api.backups(), api.version()]);
  } catch (e) {
    main.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  const verLabel = version.shaShort
    ? version.shaShort + (version.committedAt ? ' · ' + new Date(version.committedAt).toLocaleDateString('it-IT') : '')
    : 'sconosciuta';

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Impostazioni</h1><p>Aggiornamenti e backup</p></div>
      </div>

      <h2 class="section-title">Aggiornamento</h2>
      <div class="card card-pad" id="update-card">
        <div class="kv"><span>Versione installata</span><span class="mono">${escapeHtml(verLabel)}</span></div>
        <div id="update-status" class="muted" style="font-size:.9rem;margin:10px 0">
          ${
            version.repoAvailable
              ? 'Premi «Controlla» per vedere se c’è una versione più recente.'
              : 'Aggiornamento dall’app non disponibile su questa installazione — usa <span class="mono">./scripts/update.sh</span> sul server.'
          }
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="check-update" ${version.repoAvailable ? '' : 'disabled'}>${icons.refresh}<span>Controlla aggiornamenti</span></button>
          <button class="btn primary" id="do-update" hidden>${icons.download}<span>Aggiorna ora</span></button>
        </div>
      </div>

      <h2 class="section-title">Backup</h2>
      <div class="page-head" style="margin:0 0 12px">
        <p class="muted" style="font-size:.9rem">Copie CSV dei tuoi dati</p>
        <button class="btn primary" id="mk-backup">${icons.download}<span>Crea backup adesso</span></button>
      </div>

      <div class="card card-pad">
        <p class="muted" style="font-size:.9rem">
          Un backup automatico viene creato ogni <strong>domenica alle 03:00</strong> nella cartella
          <span class="mono">${escapeHtml(payload.dir)}</span> del container, montata sul tuo computer in <span class="mono">./backups</span>.
          Vengono conservati gli ultimi 8 backup.
        </p>
      </div>

      <h2 class="section-title">Backup disponibili</h2>
      <div class="card" id="bk-list">
        ${
          payload.backups.length
            ? payload.backups
                .map(
                  (b) => `
          <div class="cat-row">
            <span class="dot" style="background:var(--brand)"></span>
            <div class="meta">
              <div class="name mono">${escapeHtml(b.name)}</div>
              <div class="count">${b.createdAt ? new Date(b.createdAt).toLocaleString('it-IT') : '—'} · ${
                    b.label || 'auto'
                  }${b.tables ? ` · ${b.tables.transactions?.rows ?? 0} movimenti` : ''}</div>
            </div>
          </div>`
                )
                .join('')
            : '<div class="cat-row muted">Ancora nessun backup. Creane uno con il pulsante qui sopra.</div>'
        }
      </div>

      <h2 class="section-title">Ripristino in caso di disastro</h2>
      <div class="card card-pad">
        <p class="muted" style="font-size:.9rem;margin-bottom:10px">
          Il ripristino <strong>sostituisce tutti i dati</strong> con quelli del backup scelto. Si esegue da terminale:
        </p>
        <code class="block"># ripristina il backup più recente
docker compose run --rm web npm run restore -- --latest --yes

# oppure un backup specifico
docker compose run --rm web npm run restore -- /app/backups/NOME_BACKUP --yes</code>
        <p class="muted" style="font-size:.85rem">La procedura completa è nel README, sezione «Ripristino di emergenza».</p>
      </div>
    </div>
  `)
  );

  main.querySelector('#mk-backup').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.post('/api/backups');
      toast(`Backup creato: ${r.created}`);
      viewImpostazioni(main);
    } catch (ex) {
      toast(ex.message, 'error');
      e.target.disabled = false;
    }
  });

  const statusEl = main.querySelector('#update-status');
  const doBtn = main.querySelector('#do-update');
  main.querySelector('#check-update')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    statusEl.textContent = 'Controllo in corso…';
    try {
      const r = await api.checkUpdate();
      if (!r.supported) {
        statusEl.textContent = 'Controllo non disponibile su questa installazione.';
      } else if (r.upToDate) {
        statusEl.textContent = 'Sei all’ultima versione ✓';
        doBtn.hidden = true;
      } else {
        statusEl.innerHTML =
          `<strong>${r.behind} aggiornament${r.behind === 1 ? 'o' : 'i'} disponibil${r.behind === 1 ? 'e' : 'i'}</strong> ` +
          `(${escapeHtml(r.localShort)} → ${escapeHtml(r.remoteShort)})` +
          (r.log.length ? `<br><span class="mono" style="font-size:.8rem">${r.log.map(escapeHtml).join('<br>')}</span>` : '');
        doBtn.hidden = !version.selfUpdateEnabled;
        if (!version.selfUpdateEnabled) {
          statusEl.innerHTML +=
            `<br><br>Per aggiornare: <span class="mono">./scripts/update.sh</span> sul server, ` +
            `oppure abilita <span class="mono">SELF_UPDATE_ENABLED=true</span>.`;
        }
      }
    } catch (ex) {
      statusEl.textContent = 'Errore: ' + ex.message;
    } finally {
      e.currentTarget.disabled = false;
    }
  });

  doBtn?.addEventListener('click', async () => {
    if (!confirm('Aggiornare adesso? L’app si riavvia: sarà irraggiungibile per ~1 minuto.')) return;
    doBtn.disabled = true;
    statusEl.textContent = 'Aggiornamento in corso… (git pull + riavvio)';
    try {
      const r = await api.runUpdate();
      if (!r.updated) {
        statusEl.textContent = r.message || 'Già aggiornato.';
        doBtn.disabled = false;
        return;
      }
      statusEl.textContent = `Aggiornato a ${r.to}. Riavvio in corso, attendo che l’app torni online…`;
      // poll health then version
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        try {
          const v = await api.version();
          if (v.shaShort && v.shaShort !== version.shaShort) {
            toast('App aggiornata ✓');
            location.reload();
            return;
          }
        } catch {
          /* container still restarting */
        }
      }
      statusEl.textContent = 'Riavvio più lungo del previsto. Ricarica la pagina tra poco.';
    } catch (ex) {
      statusEl.textContent = 'Errore: ' + (ex.message || 'aggiornamento non riuscito');
      doBtn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ tx rows */
function scopeBadge(scope) {
  const s = SCOPES[scope];
  if (!s) return '';
  return `<span class="scope-badge ${scope}">${s.icon()}${s.short}</span>`;
}

// Sub-line on a dashboard KPI card: "Pers. X · Casa Y" (only when not filtered).
function statSplit(block, key) {
  if (state.scope !== '' || !block.personal) {
    return `<span class="sub">${escapeHtml(periodLabel(state.period, state.anchor))}</span>`;
  }
  const p = key === 'net' ? block.personal.net : block.personal[key];
  const hh = key === 'net' ? block.home.net : block.home[key];
  return `<span class="sub stat-split">
    <span>${icons.person}${fmtEur(p)}</span>
    <span>${icons.home}${fmtEur(hh)}</span>
  </span>`;
}

function scopeSplitBlock(split) {
  const s = split || { personal: { expense: 0 }, home: { expense: 0 } };
  const pe = s.personal.expense || 0;
  const he = s.home.expense || 0;
  const tot = pe + he;
  const pct = tot > 0 ? Math.round((pe / tot) * 100) : 50;
  return `
    <div class="split-bar" role="img" aria-label="Personale ${fmtEur(pe)}, Casa ${fmtEur(he)}">
      <span style="width:${pct}%;background:var(--brand)"></span>
      <span style="width:${100 - pct}%;background:var(--accent)"></span>
    </div>
    <div class="legend" style="margin-top:12px">
      <div class="row"><span class="dot" style="background:var(--brand)"></span>Personale<span class="amt">${fmtEur(pe)}</span></div>
      <div class="row"><span class="dot" style="background:var(--accent)"></span>Casa<span class="amt">${fmtEur(he)}</span></div>
    </div>`;
}

function txRow(t) {
  const initial = (t.categoryName || '?').charAt(0).toUpperCase();
  const sub = [t.categoryName || 'Senza categoria', t.accountName, dtfShort.format(parseISO(t.occurredOn))]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  return `
    <div class="tx" data-id="${t.id}">
      <span class="swatch" style="background:${t.categoryColor || 'var(--ink-faint)'}">${escapeHtml(initial)}</span>
      <div class="meta">
        <div class="name">${escapeHtml(t.note || t.categoryName || (t.type === 'income' ? 'Entrata' : 'Spesa'))} ${scopeBadge(t.scope)}${
          t.recurringRuleId ? `<span class="scope-badge fissa">${icons.repeat}fissa</span>` : ''
        }</div>
        <div class="cat">${sub}</div>
      </div>
      <span class="amount ${t.type}">${t.type === 'income' ? '+' : '−'}${fmtEur(t.amount)}</span>
      <span class="row-actions">
        <button class="icon-btn tx-edit" aria-label="Modifica">${icons.edit}</button>
        <button class="icon-btn tx-del" aria-label="Elimina">${icons.trash}</button>
      </span>
    </div>`;
}

function bindTxRows(container, onChange) {
  container.querySelectorAll('.tx-edit').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.tx').dataset.id;
      const { transactions } = await api.transactions(`limit=500`);
      const tx = transactions.find((t) => String(t.id) === id);
      openTxModal(tx, onChange);
    })
  );
  container.querySelectorAll('.tx-del').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('.tx').dataset.id;
      if (!confirm('Eliminare questo movimento?')) return;
      try {
        await api.del(`/api/transactions/${id}`);
        toast('Movimento eliminato');
        onChange();
      } catch (e) {
        toast(e.message, 'error');
      }
    })
  );
}

/* ------------------------------------------------------------------ modals */
function modal(inner) {
  const bd = h(`<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${inner}</div></div>`);
  const close = () => bd.remove();
  bd.addEventListener('click', (e) => {
    if (e.target === bd) close();
  });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(bd);
  return { bd, close };
}

async function openTxModal(tx = null, onChange) {
  const cats = state._categories || (await api.categories()).categories;
  state._categories = cats;
  const accounts = state._accounts || (await api.accounts()).accounts;
  state._accounts = accounts;
  const editing = !!tx;
  const t = tx || {
    type: 'expense',
    amount: '',
    categoryId: cats.find((c) => c.kind === 'expense' && c.scope === 'personal')?.id,
    accountId: accounts[0]?.id ?? null,
    scope: 'personal',
    note: '',
    occurredOn: today(),
  };

  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica movimento' : 'Nuovo movimento'}</h2>
    <form id="tx-form">
      <div class="row-2">
        <div class="field">
          <label>Tipo</label>
          <label class="switch-row">
            <span class="switch-label expense ${t.type === 'expense' ? 'on' : ''}">Uscita</span>
            <span class="switch type-switch">
              <input type="checkbox" id="typeSwitch" ${t.type === 'income' ? 'checked' : ''} />
              <span class="switch-track"></span>
            </span>
            <span class="switch-label income ${t.type === 'income' ? 'on' : ''}">Entrata</span>
          </label>
        </div>
        <div class="field">
          <label>Ambito</label>
          <label class="switch-row">
            <span class="switch-label personal ${t.scope === 'personal' ? 'on' : ''}">${icons.person}Personale</span>
            <span class="switch">
              <input type="checkbox" id="scope" name="scope" ${t.scope === 'home' ? 'checked' : ''} />
              <span class="switch-track"></span>
            </span>
            <span class="switch-label home ${t.scope === 'home' ? 'on' : ''}">${icons.home}Casa</span>
          </label>
        </div>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="amount">Importo (€)</label>
          <input id="amount" name="amount" type="number" step="0.01" min="0.01" required
                 inputmode="decimal" value="${t.amount || ''}" />
        </div>
        <div class="field">
          <label for="occurredOn">Data</label>
          <input id="occurredOn" name="occurredOn" type="date" required value="${t.occurredOn}" />
        </div>
      </div>
      ${catField('categoryId')}
      <div class="field">
        <label for="accountId">Conto</label>
        <select id="accountId" name="accountId">
          <option value="">Nessun conto</option>
          ${accounts
            .map(
              (acc) =>
                `<option value="${acc.id}" ${String(acc.id) === String(t.accountId) ? 'selected' : ''}>${escapeHtml(acc.name)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="field">
        <label for="note">Nota</label>
        <input id="note" name="note" maxlength="280" autocomplete="off" list="tx-note-list"
               value="${escapeHtml(t.note || '')}" placeholder="Facoltativa" />
        <datalist id="tx-note-list"></datalist>
        <div class="suggest-line" id="tx-suggest" hidden></div>
      </div>
      <span class="error" id="tx-err"></span>
      <div class="modal-actions">
        ${editing ? '<button type="button" class="btn danger" id="tx-delete">Elimina</button>' : ''}
        <button type="button" class="btn ghost" id="tx-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Aggiungi'}</button>
      </div>
    </form>
  `);

  const form = bd.querySelector('#tx-form');
  let type = t.type;
  let scope = t.scope;
  const catSelect = form.querySelector('#categoryId');
  const fillCats = (sel = t.categoryId) => {
    const opts = cats.filter((c) => c.kind === type && c.scope === scope);
    catSelect.innerHTML =
      '<option value="">Senza categoria</option>' +
      opts.map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  };
  fillCats();
  wireQuickCat(form, { selectId: 'categoryId', cats, getKind: () => type, getScope: () => scope, refill: fillCats });

  const typeSwitch = form.querySelector('#typeSwitch');
  const syncType = () => {
    type = typeSwitch.checked ? 'income' : 'expense';
    form.querySelector('.switch-label.expense').classList.toggle('on', type === 'expense');
    form.querySelector('.switch-label.income').classList.toggle('on', type === 'income');
    fillCats(catSelect.value || t.categoryId);
    askSug();
  };
  typeSwitch.addEventListener('change', syncType);

  const scopeInput = form.querySelector('#scope');
  const syncScope = () => {
    scope = scopeInput.checked ? 'home' : 'personal';
    form.querySelector('.switch-label.personal').classList.toggle('on', scope === 'personal');
    form.querySelector('.switch-label.home').classList.toggle('on', scope === 'home');
    fillCats(catSelect.value || t.categoryId);
    askSug();
  };
  scopeInput.addEventListener('change', syncScope);

  // --- suggerimenti da storico personale: descrizione, categoria, conto ---
  const accSelect = form.querySelector('#accountId');
  const noteInput = form.querySelector('#note');
  const noteList = form.querySelector('#tx-note-list');
  const suggestLine = form.querySelector('#tx-suggest');
  let catTouched = editing;
  let accTouched = editing;
  let lastSug = null;

  catSelect.addEventListener('change', () => {
    catTouched = true;
    paintSug();
  });
  accSelect.addEventListener('change', () => {
    accTouched = true;
    paintSug();
  });

  function paintSug() {
    const s = lastSug;
    const cat = s && s.category && String(s.category.id) !== catSelect.value ? s.category : null;
    const acc = s && s.account && String(s.account.id) !== accSelect.value ? s.account : null;
    if (!cat && !acc) {
      suggestLine.hidden = true;
      suggestLine.innerHTML = '';
      return;
    }
    const chip = (x) => `<span class="sug-dot" style="background:${x.color}"></span>${escapeHtml(x.name)}`;
    const vals = [cat && chip(cat), acc && chip(acc)].filter(Boolean).join('<span class="sug-sep">·</span>');
    suggestLine.innerHTML =
      `<span class="sug-label">${icons.target}Suggerito</span>` +
      `<span class="sug-vals">${vals}</span>` +
      `<button type="button" class="sug-apply">Applica</button>`;
    suggestLine.hidden = false;
    suggestLine.querySelector('.sug-apply').addEventListener('click', () => {
      if (cat) {
        catSelect.value = String(cat.id);
        catTouched = true;
      }
      if (acc) {
        accSelect.value = String(acc.id);
        accTouched = true;
      }
      paintSug();
    });
  }

  function applySug(s) {
    lastSug = s;
    noteList.innerHTML = (s.descriptions || [])
      .map((d) => `<option value="${escapeHtml(d)}"></option>`)
      .join('');
    if (!catTouched && s.category && [...catSelect.options].some((o) => o.value === String(s.category.id))) {
      catSelect.value = String(s.category.id);
    }
    if (!accTouched && s.account && [...accSelect.options].some((o) => o.value === String(s.account.id))) {
      accSelect.value = String(s.account.id);
    }
    paintSug();
  }

  let sugTimer;
  function askSug() {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      try {
        applySug(await api.txSuggest({ note: noteInput.value, type, scope }));
      } catch {
        /* i suggerimenti sono un extra: in caso di errore si ignora */
      }
    }, 280);
  }
  noteInput.addEventListener('input', askSug);
  askSug();

  form.querySelector('#tx-cancel').addEventListener('click', close);
  form.querySelector('#tx-delete')?.addEventListener('click', async () => {
    if (!confirm('Eliminare questo movimento?')) return;
    await api.del(`/api/transactions/${tx.id}`);
    close();
    toast('Movimento eliminato');
    onChange?.();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = {
      type,
      amount: Number(fd.amount),
      categoryId: fd.categoryId ? Number(fd.categoryId) : null,
      accountId: fd.accountId ? Number(fd.accountId) : null,
      scope: scopeInput.checked ? 'home' : 'personal',
      note: fd.note || '',
      occurredOn: fd.occurredOn,
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api.patch(`/api/transactions/${tx.id}`, body);
      else await api.post('/api/transactions', body);
      close();
      toast(editing ? 'Movimento aggiornato' : 'Movimento aggiunto');
      onChange?.();
      if (!onChange && state.view === 'dashboard') renderView();
    } catch (ex) {
      form.querySelector('#tx-err').textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/**
 * Category <select> with an inline "+ new category" panel, for use inside other
 * modals. `catField(id)` renders the markup; `wireQuickCat` binds it.
 */
function catField(id, label = 'Categoria', name = id) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <div class="with-add">
        <select id="${id}" name="${name}"></select>
        <button type="button" class="icon-btn qc-add" data-for="${id}" aria-label="Nuova categoria">${icons.plus}</button>
      </div>
      <div class="quick-cat" data-for="${id}" hidden>
        <input class="qc-name" maxlength="60" placeholder="Nome nuova categoria" />
        <input class="qc-color" type="color" value="#6c8cff" aria-label="Colore" />
        <button type="button" class="btn primary qc-save">OK</button>
      </div>
    </div>`;
}

function wireQuickCat(form, { selectId, cats, getKind, getScope, refill }) {
  const addBtn = form.querySelector(`.qc-add[data-for="${selectId}"]`);
  const panel = form.querySelector(`.quick-cat[data-for="${selectId}"]`);
  if (!addBtn || !panel) return;
  const nameInput = panel.querySelector('.qc-name');
  addBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) nameInput.focus();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      panel.querySelector('.qc-save').click();
    }
  });
  panel.querySelector('.qc-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    try {
      const { category } = await api.post('/api/categories', {
        name,
        color: panel.querySelector('.qc-color').value,
        kind: getKind(),
        scope: getScope ? getScope() : 'personal',
      });
      cats.push({ ...category, tx_count: 0 });
      state._categories = null; // invalidate shared cache
      panel.hidden = true;
      nameInput.value = '';
      refill(category.id);
      toast('Categoria creata');
    } catch (ex) {
      toast(ex.details?.[0]?.message || ex.message, 'error');
    }
  });
}

function openCatModal(cat = null, onChange) {
  const editing = !!cat;
  const c = cat || { name: '', color: '#6c8cff', kind: 'expense', scope: 'personal' };
  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica categoria' : 'Nuova categoria'}</h2>
    <form id="cat-form">
      <div class="field">
        <label for="cname">Nome</label>
        <input id="cname" name="name" required maxlength="60" value="${escapeHtml(c.name)}" />
      </div>
      <div class="row-2">
        <div class="field">
          <label for="ckind">Tipo</label>
          <select id="ckind" name="kind" ${editing ? 'disabled' : ''}>
            <option value="expense" ${c.kind === 'expense' ? 'selected' : ''}>Spesa</option>
            <option value="income" ${c.kind === 'income' ? 'selected' : ''}>Entrata</option>
          </select>
        </div>
        <div class="field">
          <label for="ccolor">Colore</label>
          <input id="ccolor" name="color" type="color" value="${c.color}" style="height:44px;padding:4px" />
        </div>
      </div>
      <div class="field">
        <label>Ambito</label>
        <label class="switch-row">
          <span class="switch-label personal ${c.scope === 'personal' ? 'on' : ''}">${icons.person}Personale</span>
          <span class="switch">
            <input type="checkbox" id="cscope" ${c.scope === 'home' ? 'checked' : ''} />
            <span class="switch-track"></span>
          </span>
          <span class="switch-label home ${c.scope === 'home' ? 'on' : ''}">${icons.home}Casa</span>
        </label>
      </div>
      <span class="error" id="cat-err"></span>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="cat-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Crea'}</button>
      </div>
    </form>
  `);
  const form = bd.querySelector('#cat-form');
  const cscope = form.querySelector('#cscope');
  cscope.addEventListener('change', () => {
    form.querySelector('.switch-label.personal').classList.toggle('on', !cscope.checked);
    form.querySelector('.switch-label.home').classList.toggle('on', cscope.checked);
  });
  form.querySelector('#cat-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const scope = cscope.checked ? 'home' : 'personal';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api.patch(`/api/categories/${cat.id}`, { name: fd.name, color: fd.color, scope });
      else await api.post('/api/categories', { name: fd.name, color: fd.color, kind: fd.kind, scope });
      close();
      toast(editing ? 'Categoria aggiornata' : 'Categoria creata');
      onChange?.();
    } catch (ex) {
      form.querySelector('#cat-err').textContent = ex.details?.[0]?.message || ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ helpers */
function emptyState(msg) {
  return `
    <div class="empty">
      <svg viewBox="0 0 200 140" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="30" y="40" width="140" height="80" rx="12" fill="var(--bg-sunken)"/>
        <rect x="30" y="40" width="140" height="24" rx="12" fill="var(--line)"/>
        <circle cx="100" cy="86" r="20" fill="none" stroke="var(--ink-faint)" stroke-width="3"/>
        <line x1="100" y1="78" x2="100" y2="94" stroke="var(--ink-faint)" stroke-width="3" stroke-linecap="round"/>
        <line x1="92" y1="86" x2="108" y2="86" stroke="var(--ink-faint)" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <p>${escapeHtml(msg)}</p>
    </div>`;
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

function monthOptions(selected) {
  const out = [];
  const now = parseISO(today());
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const val = toISO(d);
    out.push(
      `<option value="${val}" ${val === selected ? 'selected' : ''}>${capitalize(dtfMonth.format(d))}</option>`
    );
  }
  return out.join('');
}

/* ------------------------------------------------------------------ routing */
window.addEventListener('hashchange', () => {
  if (!state.user) return;
  renderView();
});

boot();
