import { Account, Category, PaymentInstallment, Transaction } from '../types';

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-alimentari', name: 'Alimentari', color: '#4cc9a4', kind: 'expense', scope: 'home', icon: 'ShoppingBag' },
  { id: 'cat-casa', name: 'Casa & Bollette', color: '#6c8cff', kind: 'expense', scope: 'home', icon: 'Home' },
  { id: 'cat-trasporti', name: 'Trasporti', color: '#f4a259', kind: 'expense', scope: 'personal', icon: 'Car' },
  { id: 'cat-salute', name: 'Salute', color: '#e15c7b', kind: 'expense', scope: 'personal', icon: 'HeartPulse' },
  { id: 'cat-svago', name: 'Svago', color: '#b57edc', kind: 'expense', scope: 'personal', icon: 'Gamepad2' },
  { id: 'cat-ristoranti', name: 'Ristoranti', color: '#f4d35e', kind: 'expense', scope: 'personal', icon: 'UtensilsCrossed' },
  { id: 'cat-shopping', name: 'Shopping', color: '#5cc8e1', kind: 'expense', scope: 'personal', icon: 'Tag' },
  { id: 'cat-altro', name: 'Altro', color: '#9aa4b2', kind: 'expense', scope: 'personal', icon: 'MoreHorizontal' },
  { id: 'cat-stipendio', name: 'Stipendio', color: '#2fb380', kind: 'income', scope: 'personal', icon: 'Banknote' },
  { id: 'cat-rimborsi', name: 'Rimborsi', color: '#7bd389', kind: 'income', scope: 'personal', icon: 'Receipt' },
  { id: 'cat-extra', name: 'Extra', color: '#a0d995', kind: 'income', scope: 'personal', icon: 'Sparkles' },
];

export const DEFAULT_ACCOUNTS: Account[] = [
  { id: 'acc-banca', name: 'Conto Corrente', kind: 'bank', color: '#6c8cff', initialBalanceCents: 320000 },
  { id: 'acc-carta', name: 'Carta di Credito', kind: 'card', color: '#b57edc', initialBalanceCents: 45000 },
  { id: 'acc-contanti', name: 'Contanti', kind: 'cash', color: '#4cc9a4', initialBalanceCents: 18000 },
  { id: 'acc-risparmio', name: 'Fondo Risparmio', kind: 'savings', color: '#2fb380', initialBalanceCents: 850000 },
];

export const DEFAULT_INSTALLMENTS: PaymentInstallment[] = [
  {
    id: 'inst-1',
    planName: 'Rata Condominio Q4',
    due_on: '2026-11-15',
    amount_cents: 14500, // 145.00 €
    categoryId: 'cat-casa',
    accountId: 'acc-banca',
    scope: 'home',
    paid: false,
  },
  {
    id: 'inst-2',
    planName: 'Assicurazione Auto Semestrale',
    due_on: '2026-11-20',
    amount_cents: 28500, // 285.00 €
    categoryId: 'cat-trasporti',
    accountId: 'acc-banca',
    scope: 'personal',
    paid: false,
  },
  {
    id: 'inst-3',
    planName: 'Tassa Rifiuti TARI',
    due_on: '2026-10-15',
    amount_cents: 11000,
    categoryId: 'cat-casa',
    accountId: 'acc-banca',
    scope: 'home',
    paid: true,
  },
];

// Helper to format ISO date string
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Generate realistic transactions across previous months and current month
export function generateSeedTransactions(): Transaction[] {
  const txs: Transaction[] = [];
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth(); // 0-indexed

  // Generate 6 months of data (months -5 to 0)
  for (let mOffset = -5; mOffset <= 0; mOffset++) {
    const targetDate = new Date(currentYear, currentMonth + mOffset, 1);
    const y = targetDate.getFullYear();
    const m = targetDate.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const isCurrentMonth = mOffset === 0;
    const maxDay = isCurrentMonth ? Math.min(today.getDate(), 28) : 28;

    // Monthly Salary (Stipendio) on 27th or 1st
    txs.push({
      id: `seed-salary-${y}-${mStr}`,
      type: 'income',
      amount_cents: 245000, // 2.450,00 €
      categoryId: 'cat-stipendio',
      accountId: 'acc-banca',
      scope: 'personal',
      note: 'Stipendio mensile',
      occurred_on: `${y}-${mStr}-01`,
      isFixed: true,
    });

    // Occasional Extra / Reimbursement
    if (mOffset % 2 === 0) {
      txs.push({
        id: `seed-extra-${y}-${mStr}`,
        type: 'income',
        amount_cents: 18000 + (mOffset + 6) * 1500,
        categoryId: 'cat-extra',
        accountId: 'acc-carta',
        scope: 'personal',
        note: 'Vendita online / Freelance extra',
        occurred_on: `${y}-${mStr}-12`,
      });
    }

    // Fixed expense: Affitto / Mutuo casa
    txs.push({
      id: `seed-rent-${y}-${mStr}`,
      type: 'expense',
      amount_cents: 72000, // 720,00 €
      categoryId: 'cat-casa',
      accountId: 'acc-banca',
      scope: 'home',
      note: 'Canone affitto casa',
      occurred_on: `${y}-${mStr}-03`,
      isFixed: true,
    });

    // Fixed expense: Fibra Internet & Utenze
    txs.push({
      id: `seed-utilities-${y}-${mStr}`,
      type: 'expense',
      amount_cents: 3490, // 34,90 €
      categoryId: 'cat-casa',
      accountId: 'acc-banca',
      scope: 'home',
      note: 'Fibra Internet Casa',
      occurred_on: `${y}-${mStr}-08`,
      isFixed: true,
    });

    // Fixed expense: Palestra / Abbonamento
    txs.push({
      id: `seed-gym-${y}-${mStr}`,
      type: 'expense',
      amount_cents: 4900, // 49,00 €
      categoryId: 'cat-svago',
      accountId: 'acc-carta',
      scope: 'personal',
      note: 'Abbonamento mensile Palestra',
      occurred_on: `${y}-${mStr}-05`,
      isFixed: true,
    });

    // Supermarket runs (3-4 times per month up to maxDay)
    const foodDays = [4, 11, 18, 25].filter((d) => d <= maxDay);
    foodDays.forEach((d, idx) => {
      txs.push({
        id: `seed-food-${y}-${mStr}-${d}`,
        type: 'expense',
        amount_cents: Math.round(6500 + ((idx * 17 + mOffset * 23) % 40) * 100),
        categoryId: 'cat-alimentari',
        accountId: idx % 2 === 0 ? 'acc-carta' : 'acc-banca',
        scope: 'home',
        note: idx % 2 === 0 ? 'Spesa Esselunga settimanale' : 'Spesa Conad',
        occurred_on: `${y}-${mStr}-${String(d).padStart(2, '0')}`,
      });
    });

    // Restaurants / Aperitivi
    const diningDays = [6, 14, 21].filter((d) => d <= maxDay);
    diningDays.forEach((d, idx) => {
      txs.push({
        id: `seed-dine-${y}-${mStr}-${d}`,
        type: 'expense',
        amount_cents: 3200 + idx * 1200,
        categoryId: 'cat-ristoranti',
        accountId: 'acc-carta',
        scope: 'personal',
        note: idx === 0 ? 'Pizzeria con amici' : 'Cena giapponese',
        occurred_on: `${y}-${mStr}-${String(d).padStart(2, '0')}`,
      });
    });

    // Fuel / Transport
    const transportDays = [9, 23].filter((d) => d <= maxDay);
    transportDays.forEach((d) => {
      txs.push({
        id: `seed-transp-${y}-${mStr}-${d}`,
        type: 'expense',
        amount_cents: 5500,
        categoryId: 'cat-trasporti',
        accountId: 'acc-carta',
        scope: 'personal',
        note: 'Rifornimento benzina',
        occurred_on: `${y}-${mStr}-${String(d).padStart(2, '0')}`,
      });
    });

    // Health / Pharmacy
    if (mOffset % 3 === 0 && 15 <= maxDay) {
      txs.push({
        id: `seed-health-${y}-${mStr}-15`,
        type: 'expense',
        amount_cents: 3850,
        categoryId: 'cat-salute',
        accountId: 'acc-contanti',
        scope: 'personal',
        note: 'Farmacia & integratori',
        occurred_on: `${y}-${mStr}-15`,
      });
    }

    // Shopping / Tech
    if (mOffset % 2 !== 0 && 19 <= maxDay) {
      txs.push({
        id: `seed-shop-${y}-${mStr}-19`,
        type: 'expense',
        amount_cents: 8900,
        categoryId: 'cat-shopping',
        accountId: 'acc-carta',
        scope: 'personal',
        note: 'Abbigliamento / Scarpe autunno',
        occurred_on: `${y}-${mStr}-19`,
      });
    }

    // Small cash expenses (coffee, bakery, parking)
    const cashDays = [2, 7, 13, 20].filter((d) => d <= maxDay);
    cashDays.forEach((d) => {
      txs.push({
        id: `seed-cash-${y}-${mStr}-${d}`,
        type: 'expense',
        amount_cents: 850,
        categoryId: 'cat-altro',
        accountId: 'acc-contanti',
        scope: 'personal',
        note: 'Caffè, colazione e parcheggio',
        occurred_on: `${y}-${mStr}-${String(d).padStart(2, '0')}`,
      });
    });
  }

  // Sort descending by date
  return txs.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
}
