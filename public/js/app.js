import { api } from './api.js';
import { donut, bars, spark, fmtEur, escapeHtml } from './charts.js';
import { icons, logoMark } from './icons.js';

const root = document.getElementById('app');
const state = { user: null, view: 'dashboard', anchor: today(), period: 'month' };

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
function renderAuth() {
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
        <div class="auth-tabs">
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
  { id: 'dashboard', label: 'Dashboard', icon: icons.dashboard },
  { id: 'movimenti', label: 'Movimenti', icon: icons.list },
  { id: 'categorie', label: 'Categorie', icon: icons.tag },
  { id: 'backup', label: 'Backup', icon: icons.archive },
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
          (n) => `<button data-view="${n.id}" class="${n.id === state.view ? 'active' : ''}">${n.icon}<span>${n.label}</span></button>`
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
    categorie: viewCategorie,
    backup: viewBackup,
  }[state.view])(main);
}

/* ------------------------------------------------------------------ dashboard */
async function viewDashboard(main) {
  let data;
  try {
    data = await api.overview(state.anchor);
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
          <h1>Ciao ${escapeHtml(state.user.displayName || '')}</h1>
          <p>Il tuo quadro finanziario</p>
        </div>
        <div class="segment" id="period-seg">
          <button data-p="day" class="${p === 'day' ? 'active' : ''}">Giorno</button>
          <button data-p="week" class="${p === 'week' ? 'active' : ''}">Settimana</button>
          <button data-p="month" class="${p === 'month' ? 'active' : ''}">Mese</button>
        </div>
      </div>

      <div class="period-nav" style="margin-bottom:18px">
        <button class="icon-btn" id="prev" aria-label="Periodo precedente">${icons.chevronL}</button>
        <span class="range">${escapeHtml(periodLabel(p, state.anchor))}</span>
        <button class="icon-btn" id="next" aria-label="Periodo successivo">${icons.chevronR}</button>
        <button class="btn ghost" id="today-btn" style="margin-left:6px">Oggi</button>
      </div>

      <div class="grid cols-3">
        <div class="card stat income">
          <span class="label">Entrate</span>
          <span class="value">${fmtEur(block.income)}</span>
          <span class="sub">${escapeHtml(periodLabel(p, state.anchor))}</span>
          <div class="spark">${spark(trend.map((t) => t.income), { color: 'var(--income)' })}</div>
        </div>
        <div class="card stat expense">
          <span class="label">Uscite</span>
          <span class="value">${fmtEur(block.expense)}</span>
          <span class="sub">${escapeHtml(periodLabel(p, state.anchor))}</span>
          <div class="spark">${spark(trend.map((t) => t.expense), { color: 'var(--expense)' })}</div>
        </div>
        <div class="card stat">
          <span class="label">Saldo</span>
          <span class="value" style="color:${block.net >= 0 ? 'var(--income)' : 'var(--expense)'}">${fmtEur(block.net)}</span>
          <span class="sub">${block.net >= 0 ? 'in positivo' : 'in negativo'}</span>
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

      <h2 class="section-title">Movimenti recenti</h2>
      <div class="card" id="recent"></div>
    </div>
  `)
  );

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
  const { transactions } = await api.transactions(`from=${from}&to=${to}&limit=8`);
  const recent = main.querySelector('#recent');
  recent.innerHTML =
    transactions.length === 0
      ? emptyState('Nessun movimento in questo periodo.')
      : transactions.map(txRow).join('');
  bindTxRows(recent, () => viewDashboard(main));
}

/* ------------------------------------------------------------------ movimenti */
async function viewMovimenti(main) {
  const [{ categories }] = await Promise.all([api.categories()]);
  state._categories = categories;
  const filters = state._txFilters || { type: '', categoryId: '', month: startOfMonth(today()) };
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

  loadTxList(main);
}

async function loadTxList(main) {
  const f = state._txFilters;
  const from = f.month;
  const to = endOfMonth(f.month);
  const qs = new URLSearchParams({ from, to, limit: '500' });
  if (f.type) qs.set('type', f.type);
  if (f.categoryId) qs.set('categoryId', f.categoryId);

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
  const groups = { expense: [], income: [] };
  categories.forEach((c) => groups[c.kind].push(c));

  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Categorie</h1><p>Organizza spese ed entrate</p></div>
        <button class="btn primary" id="add-cat">${icons.plus}<span>Nuova</span></button>
      </div>
      ${['expense', 'income']
        .map(
          (kind) => `
        <h2 class="section-title">${kind === 'expense' ? 'Spese' : 'Entrate'}</h2>
        <div class="card">
          ${
            groups[kind].length
              ? groups[kind]
                  .map(
                    (c) => `
            <div class="cat-row" data-id="${c.id}">
              <span class="dot" style="background:${c.color}"></span>
              <span class="name">${escapeHtml(c.name)}</span>
              <span class="count">${c.tx_count} mov.</span>
              <button class="icon-btn edit-cat" aria-label="Modifica">${icons.edit}</button>
              <button class="icon-btn del-cat" aria-label="Elimina">${icons.trash}</button>
            </div>`
                  )
                  .join('')
              : '<div class="cat-row muted">Nessuna categoria</div>'
          }
        </div>`
        )
        .join('')}
    </div>
  `)
  );

  main.querySelector('#add-cat').addEventListener('click', () => openCatModal(null, () => viewCategorie(main)));
  main.querySelectorAll('.edit-cat').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.closest('.cat-row').dataset.id);
      openCatModal(categories.find((c) => c.id === id), () => viewCategorie(main));
    })
  );
  main.querySelectorAll('.del-cat').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.closest('.cat-row').dataset.id);
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

/* ------------------------------------------------------------------ backup */
async function viewBackup(main) {
  let payload;
  try {
    payload = await api.backups();
  } catch (e) {
    main.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  main.innerHTML = '';
  main.appendChild(
    h(`
    <div>
      <div class="page-head">
        <div><h1>Backup</h1><p>Copie CSV dei tuoi dati</p></div>
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
            <div>
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
      viewBackup(main);
    } catch (ex) {
      toast(ex.message, 'error');
      e.target.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ tx rows */
function txRow(t) {
  const initial = (t.categoryName || '?').charAt(0).toUpperCase();
  return `
    <div class="tx" data-id="${t.id}">
      <span class="swatch" style="background:${t.categoryColor || 'var(--ink-faint)'}">${escapeHtml(initial)}</span>
      <div class="meta">
        <div class="name">${escapeHtml(t.note || t.categoryName || (t.type === 'income' ? 'Entrata' : 'Spesa'))}</div>
        <div class="cat">${escapeHtml(t.categoryName || 'Senza categoria')} · ${escapeHtml(dtfShort.format(parseISO(t.occurredOn)))}</div>
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
      const id = Number(b.closest('.tx').dataset.id);
      const { transactions } = await api.transactions(`limit=500`);
      const tx = transactions.find((t) => t.id === id);
      openTxModal(tx, onChange);
    })
  );
  container.querySelectorAll('.tx-del').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.closest('.tx').dataset.id);
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
  const editing = !!tx;
  const t = tx || { type: 'expense', amount: '', categoryId: cats.find((c) => c.kind === 'expense')?.id, note: '', occurredOn: today() };

  const { bd, close } = modal(`
    <h2>${editing ? 'Modifica movimento' : 'Nuovo movimento'}</h2>
    <form id="tx-form">
      <div class="segment" id="type-seg" style="margin-bottom:14px">
        <button type="button" data-t="expense" class="${t.type === 'expense' ? 'active' : ''}">Uscita</button>
        <button type="button" data-t="income" class="${t.type === 'income' ? 'active' : ''}">Entrata</button>
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
      <div class="field">
        <label for="categoryId">Categoria</label>
        <select id="categoryId" name="categoryId"></select>
      </div>
      <div class="field">
        <label for="note">Nota</label>
        <input id="note" name="note" maxlength="280" value="${escapeHtml(t.note || '')}" placeholder="Facoltativa" />
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
  const catSelect = form.querySelector('#categoryId');
  const fillCats = () => {
    const opts = cats.filter((c) => c.kind === type);
    catSelect.innerHTML =
      '<option value="">Senza categoria</option>' +
      opts.map((c) => `<option value="${c.id}" ${String(c.id) === String(t.categoryId) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  };
  fillCats();

  form.querySelector('#type-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    type = b.dataset.t;
    form.querySelectorAll('#type-seg button').forEach((x) => x.classList.toggle('active', x === b));
    fillCats();
  });

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

function openCatModal(cat = null, onChange) {
  const editing = !!cat;
  const c = cat || { name: '', color: '#6c8cff', kind: 'expense' };
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
      <span class="error" id="cat-err"></span>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="cat-cancel">Annulla</button>
        <button type="submit" class="btn primary">${editing ? 'Salva' : 'Crea'}</button>
      </div>
    </form>
  `);
  const form = bd.querySelector('#cat-form');
  form.querySelector('#cat-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api.patch(`/api/categories/${cat.id}`, { name: fd.name, color: fd.color });
      else await api.post('/api/categories', { name: fd.name, color: fd.color, kind: fd.kind });
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
