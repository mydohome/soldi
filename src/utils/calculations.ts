import {
  Account,
  Category,
  CategoryBreakdownItem,
  FlashInsights,
  MonthlyTrendPoint,
  PaymentInstallment,
  PeriodType,
  Transaction,
  TransactionScope,
  TransactionType,
} from '../types';

export const fmtEur = (amount: number): string => {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export const fmtEur0 = (amount: number): string => {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(amount);
};

export const centsToEuros = (cents: number): number => cents / 100;
export const eurosToCents = (euros: number): number => Math.round(euros * 100);

export function getAccountBalances(
  accounts: Account[],
  transactions: Transaction[],
  scopeFilter?: TransactionScope | 'all'
): {
  accountsWithBalance: Array<Account & { currentBalance: number; expenseTotal: number; incomeTotal: number }>;
  totalBalance: number;
} {
  const result = accounts.map((acc) => {
    const accTxs = transactions.filter((t) => {
      if (t.accountId !== acc.id) return false;
      if (scopeFilter && scopeFilter !== 'all' && t.scope !== scopeFilter) return false;
      return true;
    });

    const incomeCents = accTxs
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + t.amount_cents, 0);

    const expenseCents = accTxs
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount_cents, 0);

    const currentBalanceCents = acc.initialBalanceCents + incomeCents - expenseCents;

    return {
      ...acc,
      currentBalance: centsToEuros(currentBalanceCents),
      expenseTotal: centsToEuros(expenseCents),
      incomeTotal: centsToEuros(incomeCents),
    };
  });

  const totalBalance = result.reduce((sum, acc) => sum + acc.currentBalance, 0);

  return {
    accountsWithBalance: result,
    totalBalance,
  };
}

export function getDateRange(period: PeriodType, anchorIso: string): { start: string; end: string; label: string } {
  const [year, month, day] = anchorIso.split('-').map(Number);
  const d = new Date(year, month - 1, day);

  if (period === 'day') {
    const dStr = anchorIso;
    const label = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'short' });
    return {
      start: dStr,
      end: dStr,
      label: label.charAt(0).toUpperCase() + label.slice(1),
    };
  }

  if (period === 'week') {
    // Italian week starts on Monday
    const dayOfWeek = d.getDay(); // 0 is Sunday, 1 is Monday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const startIso = toIso(monday);
    const endIso = toIso(sunday);

    const label = `${monday.getDate()} ${monday.toLocaleDateString('it-IT', { month: 'short' })} – ${sunday.getDate()} ${sunday.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' })}`;
    return { start: startIso, end: endIso, label };
  }

  // Month
  const startMonth = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const endMonth = new Date(year, month - 1, lastDay);

  const startIso = toIso(startMonth);
  const endIso = toIso(endMonth);
  const rawLabel = startMonth.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);

  return { start: startIso, end: endIso, label };
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function filterTransactionsByRange(
  transactions: Transaction[],
  start: string,
  end: string,
  scope?: TransactionScope | 'all'
): Transaction[] {
  return transactions.filter((t) => {
    if (t.occurred_on < start || t.occurred_on > end) return false;
    if (scope && scope !== 'all' && t.scope !== scope) return false;
    return true;
  });
}

export function calculatePeriodSummary(filteredTxs: Transaction[]): {
  income: number;
  expense: number;
  net: number;
  txCount: number;
  personalExpense: number;
  homeExpense: number;
  personalIncome: number;
  homeIncome: number;
} {
  let incomeCents = 0;
  let expenseCents = 0;
  let personalExp = 0;
  let homeExp = 0;
  let personalInc = 0;
  let homeInc = 0;

  for (const t of filteredTxs) {
    if (t.type === 'income') {
      incomeCents += t.amount_cents;
      if (t.scope === 'personal') personalInc += t.amount_cents;
      else homeInc += t.amount_cents;
    } else {
      expenseCents += t.amount_cents;
      if (t.scope === 'personal') personalExp += t.amount_cents;
      else homeExp += t.amount_cents;
    }
  }

  const income = centsToEuros(incomeCents);
  const expense = centsToEuros(expenseCents);

  return {
    income,
    expense,
    net: income - expense,
    txCount: filteredTxs.length,
    personalExpense: centsToEuros(personalExp),
    homeExpense: centsToEuros(homeExp),
    personalIncome: centsToEuros(personalInc),
    homeIncome: centsToEuros(homeInc),
  };
}

export function getMonthlyTrend(
  transactions: Transaction[],
  anchorIso: string,
  monthsCount: 6 | 12 = 6,
  scope?: TransactionScope | 'all'
): { points: MonthlyTrendPoint[]; avgExpense: number } {
  const [anchorYear, anchorMonth] = anchorIso.split('-').map(Number);
  const points: MonthlyTrendPoint[] = [];

  for (let i = monthsCount - 1; i >= 0; i--) {
    const target = new Date(anchorYear, anchorMonth - 1 - i, 1);
    const y = target.getFullYear();
    const m = target.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const monthKey = `${y}-${mStr}`;

    const startMonth = `${monthKey}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const endMonth = `${monthKey}-${String(lastDay).padStart(2, '0')}`;

    const monthTxs = filterTransactionsByRange(transactions, startMonth, endMonth, scope);
    const summary = calculatePeriodSummary(monthTxs);

    const monthName = target.toLocaleDateString('it-IT', { month: 'short' });
    const label = `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${String(y).slice(-2)}`;

    points.push({
      monthKey,
      label,
      income: summary.income,
      expense: summary.expense,
      net: summary.net,
      txCount: summary.txCount,
    });
  }

  // Calculate average expense over months with non-zero expenses
  const monthsWithExpense = points.filter((p) => p.expense > 0);
  const avgExpense = monthsWithExpense.length > 0
    ? monthsWithExpense.reduce((sum, p) => sum + p.expense, 0) / monthsWithExpense.length
    : 0;

  return { points, avgExpense };
}

export function getCategoryBreakdown(
  categories: Category[],
  transactions: Transaction[],
  activeMonthKey: string, // YYYY-MM
  scope?: TransactionScope | 'all'
): CategoryBreakdownItem[] {
  const [year, month] = activeMonthKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const startActive = `${activeMonthKey}-01`;
  const endActive = `${activeMonthKey}-${String(lastDay).padStart(2, '0')}`;

  const currentTxs = filterTransactionsByRange(transactions, startActive, endActive, scope).filter(
    (t) => t.type === 'expense'
  );

  const totalExpenseCents = currentTxs.reduce((sum, t) => sum + t.amount_cents, 0);

  // Group by category
  const categoryMap = new Map<string, number>();
  for (const t of currentTxs) {
    const catId = t.categoryId || 'cat-altro';
    categoryMap.set(catId, (categoryMap.get(catId) || 0) + t.amount_cents);
  }

  // Calculate 3-month prior average for each category
  const prev3MonthsKeys: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const prevKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    prev3MonthsKeys.push(prevKey);
  }

  const prevTxs = transactions.filter((t) => {
    if (t.type !== 'expense') return false;
    if (scope && scope !== 'all' && t.scope !== scope) return false;
    const mKey = t.occurred_on.slice(0, 7);
    return prev3MonthsKeys.includes(mKey);
  });

  const catPrevSum = new Map<string, number>();
  for (const t of prevTxs) {
    const catId = t.categoryId || 'cat-altro';
    catPrevSum.set(catId, (catPrevSum.get(catId) || 0) + t.amount_cents);
  }

  const items: CategoryBreakdownItem[] = [];

  for (const cat of categories.filter((c) => c.kind === 'expense')) {
    const catCents = categoryMap.get(cat.id) || 0;
    const total = centsToEuros(catCents);

    const prevSumCents = catPrevSum.get(cat.id) || 0;
    const avg3Months = centsToEuros(prevSumCents / 3);

    const sharePercent = totalExpenseCents > 0 ? (catCents / totalExpenseCents) * 100 : 0;

    let deltaPercent: number | null = null;
    if (avg3Months > 0 && total > 0) {
      deltaPercent = Math.round(((total - avg3Months) / avg3Months) * 100);
    }

    if (total > 0 || avg3Months > 0) {
      items.push({
        categoryId: cat.id,
        name: cat.name,
        color: cat.color,
        total,
        sharePercent: Number(sharePercent.toFixed(1)),
        avg3Months: Number(avg3Months.toFixed(2)),
        deltaPercent,
      });
    }
  }

  return items.sort((a, b) => b.total - a.total);
}

export function calculateFlashInsights(
  transactions: Transaction[],
  activeMonthKey: string, // YYYY-MM
  scope?: TransactionScope | 'all'
): FlashInsights {
  const [year, month] = activeMonthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const daysElapsed = isCurrentMonth ? Math.min(today.getDate(), daysInMonth) : daysInMonth;

  const startMonth = `${activeMonthKey}-01`;
  const endMonth = `${activeMonthKey}-${String(daysInMonth).padStart(2, '0')}`;

  const monthTxs = filterTransactionsByRange(transactions, startMonth, endMonth, scope).filter(
    (t) => t.type === 'expense'
  );

  const totalExpenseCents = monthTxs.reduce((sum, t) => sum + t.amount_cents, 0);
  const fixedExpenseCents = monthTxs
    .filter((t) => t.isFixed)
    .reduce((sum, t) => sum + t.amount_cents, 0);

  const nonFixedExpenseCents = totalExpenseCents - fixedExpenseCents;

  const dailyAvgExpense = daysElapsed > 0 ? centsToEuros(totalExpenseCents) / daysElapsed : 0;
  const dailyAvgExcludingFixed = daysElapsed > 0 ? centsToEuros(nonFixedExpenseCents) / daysElapsed : 0;

  // Previous month daily average
  const prevDate = new Date(year, month - 2, 1);
  const prevKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const prevDays = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate();
  const prevTxs = filterTransactionsByRange(
    transactions,
    `${prevKey}-01`,
    `${prevKey}-${String(prevDays).padStart(2, '0')}`,
    scope
  ).filter((t) => t.type === 'expense');

  const prevTotalExpenseCents = prevTxs.reduce((sum, t) => sum + t.amount_cents, 0);
  const dailyAvgPrevMonth = prevDays > 0 ? centsToEuros(prevTotalExpenseCents) / prevDays : 0;

  // Highest single expense (escludendo le spese fisse, come da HANDOVER.md)
  let highestExpenseItem: FlashInsights['highestExpense'] = null;
  const nonFixedMonthTxs = monthTxs.filter((t) => !t.isFixed);
  if (nonFixedMonthTxs.length > 0) {
    const highest = [...nonFixedMonthTxs].sort((a, b) => b.amount_cents - a.amount_cents)[0];
    highestExpenseItem = {
      amount: centsToEuros(highest.amount_cents),
      note: highest.note || 'Spesa generica',
      date: highest.occurred_on,
      categoryName: highest.categoryId || 'Altro',
    };
  }

  // Highest spend day (escludendo spese fisse)
  const dayTotals = new Map<string, number>();
  for (const t of nonFixedMonthTxs) {
    dayTotals.set(t.occurred_on, (dayTotals.get(t.occurred_on) || 0) + t.amount_cents);
  }

  let highestDayItem: FlashInsights['highestDay'] = null;
  let maxDayCents = 0;
  for (const [dayStr, amountCents] of dayTotals.entries()) {
    if (amountCents > maxDayCents) {
      maxDayCents = amountCents;
      highestDayItem = {
        date: dayStr,
        amount: centsToEuros(amountCents),
      };
    }
  }

  // Projected month end expense: da HANDOVER.md la stima parte dal 5° giorno
  const projectedMonthEndExpense = isCurrentMonth && daysElapsed >= 5
    ? centsToEuros(fixedExpenseCents) + dailyAvgExcludingFixed * daysInMonth
    : centsToEuros(totalExpenseCents);

  const fixedExpensesShare = totalExpenseCents > 0
    ? (fixedExpenseCents / totalExpenseCents) * 100
    : 0;

  // Incomes of this month for savings rate
  const monthIncomes = filterTransactionsByRange(transactions, startMonth, endMonth, scope)
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + t.amount_cents, 0);

  const savingsRate = monthIncomes > 0
    ? Math.max(0, ((monthIncomes - totalExpenseCents) / monthIncomes) * 100)
    : 0;

  return {
    dailyAvgExpense: Number(dailyAvgExpense.toFixed(2)),
    dailyAvgExcludingFixed: Number(dailyAvgExcludingFixed.toFixed(2)),
    dailyAvgPrevMonth: Number(dailyAvgPrevMonth.toFixed(2)),
    highestExpense: highestExpenseItem,
    highestDay: highestDayItem,
    projectedMonthEndExpense: Number(projectedMonthEndExpense.toFixed(2)),
    fixedExpensesShare: Math.round(fixedExpensesShare),
    savingsRate: Math.round(savingsRate),
  };
}
