export type TransactionType = 'income' | 'expense';
export type TransactionScope = 'personal' | 'home';
export type AccountKind = 'bank' | 'card' | 'cash' | 'savings';
export type PeriodType = 'day' | 'week' | 'month';

export interface Category {
  id: string;
  name: string;
  color: string;
  kind: TransactionType;
  scope: TransactionScope;
  icon?: string;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  color: string;
  initialBalanceCents: number;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  amount_cents: number;
  categoryId: string | null;
  accountId: string | null;
  scope: TransactionScope;
  note: string;
  occurred_on: string; // YYYY-MM-DD
  isFixed?: boolean;
  paymentInstallmentId?: string;
}

export interface PaymentInstallment {
  id: string;
  planName: string;
  due_on: string; // YYYY-MM-DD
  amount_cents: number;
  categoryId: string;
  accountId: string;
  scope: TransactionScope;
  paid: boolean;
  transactionId?: string;
}

export interface MonthlyTrendPoint {
  monthKey: string; // YYYY-MM
  label: string;
  income: number;
  expense: number;
  net: number;
  txCount: number;
}

export interface CategoryBreakdownItem {
  categoryId: string;
  name: string;
  color: string;
  total: number;
  sharePercent: number;
  avg3Months: number;
  deltaPercent: number | null; // e.g. +14% or -5% vs 3mo avg
}

export interface FlashInsights {
  dailyAvgExpense: number;
  dailyAvgExcludingFixed: number;
  dailyAvgPrevMonth: number;
  highestExpense: {
    amount: number;
    note: string;
    date: string;
    categoryName: string;
  } | null;
  highestDay: {
    date: string;
    amount: number;
  } | null;
  projectedMonthEndExpense: number;
  fixedExpensesShare: number; // percentage
  savingsRate: number; // percentage
}
