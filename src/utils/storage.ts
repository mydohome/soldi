import {
  DEFAULT_ACCOUNTS,
  DEFAULT_CATEGORIES,
  DEFAULT_INSTALLMENTS,
  generateSeedTransactions,
} from '../data/seedData';
import { Account, Category, PaymentInstallment, Transaction } from '../types';
import { centsToEuros, eurosToCents } from './calculations';

const STORAGE_KEYS = {
  TRANSACTIONS: 'soldi_transactions_v1',
  CATEGORIES: 'soldi_categories_v1',
  ACCOUNTS: 'soldi_accounts_v1',
  INSTALLMENTS: 'soldi_installments_v1',
  THEME: 'soldi_theme_v1',
};

export function loadStoredData(): {
  transactions: Transaction[];
  categories: Category[];
  accounts: Account[];
  installments: PaymentInstallment[];
} {
  try {
    const rawTx = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    const rawCat = localStorage.getItem(STORAGE_KEYS.CATEGORIES);
    const rawAcc = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
    const rawInst = localStorage.getItem(STORAGE_KEYS.INSTALLMENTS);

    const categories: Category[] = rawCat ? JSON.parse(rawCat) : DEFAULT_CATEGORIES;
    const accounts: Account[] = rawAcc ? JSON.parse(rawAcc) : DEFAULT_ACCOUNTS;
    const installments: PaymentInstallment[] = rawInst ? JSON.parse(rawInst) : DEFAULT_INSTALLMENTS;
    const transactions: Transaction[] = rawTx ? JSON.parse(rawTx) : generateSeedTransactions();

    return { transactions, categories, accounts, installments };
  } catch (e) {
    console.error('Error loading stored Soldi data, reverting to seed', e);
    return {
      transactions: generateSeedTransactions(),
      categories: DEFAULT_CATEGORIES,
      accounts: DEFAULT_ACCOUNTS,
      installments: DEFAULT_INSTALLMENTS,
    };
  }
}

export function saveTransactions(txs: Transaction[]) {
  try {
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(txs));
  } catch (e) {
    console.error('Failed to save transactions', e);
  }
}

export function saveInstallments(inst: PaymentInstallment[]) {
  try {
    localStorage.setItem(STORAGE_KEYS.INSTALLMENTS, JSON.stringify(inst));
  } catch (e) {
    console.error('Failed to save installments', e);
  }
}

export function resetToDemoData() {
  localStorage.removeItem(STORAGE_KEYS.TRANSACTIONS);
  localStorage.removeItem(STORAGE_KEYS.CATEGORIES);
  localStorage.removeItem(STORAGE_KEYS.ACCOUNTS);
  localStorage.removeItem(STORAGE_KEYS.INSTALLMENTS);
}

export function exportTransactionsToCsv(
  transactions: Transaction[],
  categories: Category[],
  accounts: Account[]
): string {
  const catMap = new Map(categories.map((c) => [c.id, c.name]));
  const accMap = new Map(accounts.map((a) => [a.id, a.name]));

  const headers = ['Data', 'Tipo', 'Importo_EUR', 'Categoria', 'Conto', 'Ambito', 'Nota', 'Spesa_Fissa'];
  const rows = transactions.map((t) => [
    t.occurred_on,
    t.type === 'income' ? 'entrata' : 'spesa',
    centsToEuros(t.amount_cents).toFixed(2),
    `"${(catMap.get(t.categoryId || '') || 'Altro').replace(/"/g, '""')}"`,
    `"${(accMap.get(t.accountId || '') || 'Contanti').replace(/"/g, '""')}"`,
    t.scope,
    `"${(t.note || '').replace(/"/g, '""')}"`,
    t.isFixed ? 'si' : 'no',
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

export function parseCsvTransactions(
  csvText: string,
  categories: Category[],
  accounts: Account[]
): Transaction[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const catByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const accByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));

  const parsed: Transaction[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV row parser handling quotes
    const parts: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"' && (c === 0 || line[c - 1] !== '\\')) {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(cur.trim().replace(/^"|"$/g, ''));
        cur = '';
      } else {
        cur += char;
      }
    }
    parts.push(cur.trim().replace(/^"|"$/g, ''));

    if (parts.length >= 3) {
      const [dateStr, typeStr, amountStr, catName, accName, scopeStr, noteStr, isFixedStr] = parts;
      const amountEur = parseFloat(amountStr.replace(',', '.'));
      if (isNaN(amountEur) || amountEur <= 0) continue;

      const type = typeStr?.toLowerCase().includes('entr') || typeStr === 'income' ? 'income' : 'expense';
      const catId = catByName.get((catName || '').toLowerCase()) || (type === 'income' ? 'cat-stipendio' : 'cat-altro');
      const accId = accByName.get((accName || '').toLowerCase()) || 'acc-banca';
      const scope = scopeStr?.toLowerCase() === 'home' || scopeStr?.toLowerCase() === 'casa' ? 'home' : 'personal';

      parsed.push({
        id: `csv-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`,
        type,
        amount_cents: eurosToCents(amountEur),
        categoryId: catId,
        accountId: accId,
        scope,
        note: noteStr || '',
        occurred_on: dateStr || new Date().toISOString().slice(0, 10),
        isFixed: isFixedStr?.toLowerCase() === 'si' || isFixedStr?.toLowerCase() === 'true',
      });
    }
  }

  return parsed;
}
