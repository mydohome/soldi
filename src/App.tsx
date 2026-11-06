/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  Plus,
  Repeat,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { BalanceTrendChart } from './components/BalanceTrendChart';
import { CategoryDonutChart } from './components/CategoryDonutChart';
import { DataManagementModal } from './components/DataManagementModal';
import { FlashBalanceSummary } from './components/FlashBalanceSummary';
import { FlashDueAlert } from './components/FlashDueAlert';
import { FlashQuickAddModal } from './components/FlashQuickAddModal';
import { Header } from './components/Header';
import { MonthlyTrendChart } from './components/MonthlyTrendChart';
import { TransactionListModal } from './components/TransactionListModal';
import { Account, Category, PaymentInstallment, PeriodType, Transaction, TransactionScope } from './types';
import {
  calculateFlashInsights,
  calculatePeriodSummary,
  centsToEuros,
  eurosToCents,
  filterTransactionsByRange,
  fmtEur,
  getAccountBalances,
  getCategoryBreakdown,
  getDateRange,
  getMonthlyTrend,
} from './utils/calculations';
import {
  exportTransactionsToCsv,
  loadStoredData,
  resetToDemoData,
  saveInstallments,
  saveTransactions,
} from './utils/storage';

export default function App() {
  // Initial state from storage
  const [initialData] = useState(() => loadStoredData());
  const [transactions, setTransactions] = useState<Transaction[]>(initialData.transactions);
  const [categories, setCategories] = useState<Category[]>(initialData.categories);
  const [accounts, setAccounts] = useState<Account[]>(initialData.accounts);
  const [installments, setInstallments] = useState<PaymentInstallment[]>(initialData.installments);

  // View state
  const [period, setPeriod] = useState<PeriodType>('month');
  const [scope, setScope] = useState<TransactionScope | 'all'>('all');
  const [anchorDate, setAnchorDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [monthsCount, setMonthsCount] = useState<6 | 12>(6);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  });

  // Modal controls
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isTxListOpen, setIsTxListOpen] = useState(false);
  const [isDataModalOpen, setIsDataModalOpen] = useState(false);

  // Toast & Undo
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [lastDeletedTx, setLastDeletedTx] = useState<Transaction | null>(null);

  // Sync dark class on document root
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Persist transactions on update
  useEffect(() => {
    saveTransactions(transactions);
  }, [transactions]);

  // Persist installments on update
  useEffect(() => {
    saveInstallments(installments);
  }, [installments]);

  // Toggle theme
  const handleToggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Date range calculation for current period & anchor
  const dateRange = useMemo(() => {
    return getDateRange(period, anchorDate);
  }, [period, anchorDate]);

  // Active month key (YYYY-MM)
  const activeMonthKey = useMemo(() => {
    return anchorDate.slice(0, 7);
  }, [anchorDate]);

  // Filter transactions for current period
  const periodTransactions = useMemo(() => {
    let txs = filterTransactionsByRange(transactions, dateRange.start, dateRange.end, scope);
    if (selectedAccountId) {
      txs = txs.filter((t) => t.accountId === selectedAccountId);
    }
    return txs;
  }, [transactions, dateRange.start, dateRange.end, scope, selectedAccountId]);

  // Summary of the active period
  const periodSummary = useMemo(() => {
    return calculatePeriodSummary(periodTransactions);
  }, [periodTransactions]);

  // Overall account balances
  const { accountsWithBalance, totalBalance } = useMemo(() => {
    return getAccountBalances(accounts, transactions, scope);
  }, [accounts, transactions, scope]);

  // Monthly trend points (6 or 12 months)
  const { points: trendPoints, avgExpense } = useMemo(() => {
    return getMonthlyTrend(transactions, anchorDate, monthsCount, scope);
  }, [transactions, anchorDate, monthsCount, scope]);

  // Category breakdown for active month
  const categoryBreakdown = useMemo(() => {
    return getCategoryBreakdown(categories, transactions, activeMonthKey, scope);
  }, [categories, transactions, activeMonthKey, scope]);

  // Flash insights for active month
  const flashInsights = useMemo(() => {
    return calculateFlashInsights(transactions, activeMonthKey, scope);
  }, [transactions, activeMonthKey, scope]);

  // Period Navigation handlers
  const handlePrevPeriod = () => {
    const [y, m, d] = anchorDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);

    if (period === 'day') {
      date.setDate(date.getDate() - 1);
    } else if (period === 'week') {
      date.setDate(date.getDate() - 7);
    } else {
      date.setMonth(date.getMonth() - 1);
    }

    setAnchorDate(date.toISOString().slice(0, 10));
  };

  const handleNextPeriod = () => {
    const [y, m, d] = anchorDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);

    if (period === 'day') {
      date.setDate(date.getDate() + 1);
    } else if (period === 'week') {
      date.setDate(date.getDate() + 7);
    } else {
      date.setMonth(date.getMonth() + 1);
    }

    setAnchorDate(date.toISOString().slice(0, 10));
  };

  const handleToday = () => {
    setAnchorDate(new Date().toISOString().slice(0, 10));
  };

  const handleSelectMonthFromTrend = (monthKey: string) => {
    setAnchorDate(`${monthKey}-01`);
    setPeriod('month');
  };

  // Add new transaction
  const handleAddTransaction = (newTxData: Omit<Transaction, 'id'>) => {
    const newTx: Transaction = {
      ...newTxData,
      id: `tx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    };

    setTransactions((prev) => [newTx, ...prev]);

    // Toast notification
    setToastMessage(`Movimento registrato: ${fmtEur(centsToEuros(newTx.amount_cents))}`);
    setTimeout(() => {
      setToastMessage((cur) => (cur?.includes('registrato') ? null : cur));
    }, 3500);
  };

  // Delete transaction with Undo option
  const handleDeleteTransaction = (id: string) => {
    const txToDelete = transactions.find((t) => t.id === id);
    if (!txToDelete) return;

    setLastDeletedTx(txToDelete);
    setTransactions((prev) => prev.filter((t) => t.id !== id));

    setToastMessage(`Movimento eliminato.`);
    setTimeout(() => {
      setToastMessage((cur) => (cur?.includes('eliminato') ? null : cur));
    }, 4500);
  };

  // Undo delete
  const handleUndoDelete = () => {
    if (lastDeletedTx) {
      setTransactions((prev) => [lastDeletedTx, ...prev]);
      setLastDeletedTx(null);
      setToastMessage('Eliminazione annullata con successo!');
      setTimeout(() => setToastMessage(null), 3000);
    }
  };

  // Pay scheduled payment installment
  const handlePayInstallment = (installment: PaymentInstallment) => {
    const newTxId = `tx-pay-${Date.now()}`;
    const newTx: Transaction = {
      id: newTxId,
      type: 'expense',
      amount_cents: installment.amount_cents,
      categoryId: installment.categoryId,
      accountId: installment.accountId,
      scope: installment.scope,
      note: `Pagamento: ${installment.planName}`,
      occurred_on: new Date().toISOString().slice(0, 10),
      isFixed: true,
      paymentInstallmentId: installment.id,
    };

    setTransactions((prev) => [newTx, ...prev]);
    setInstallments((prev) =>
      prev.map((i) => (i.id === installment.id ? { ...i, paid: true, transactionId: newTxId } : i))
    );

    setToastMessage(`Rata "${installment.planName}" saldata! Movimento creato.`);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Import CSV
  const handleImportTransactions = (imported: Transaction[]) => {
    setTransactions((prev) => [...imported, ...prev]);
    setToastMessage(`Aggiunti ${imported.length} movimenti dal file CSV.`);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Reset to demo
  const handleResetDemo = () => {
    resetToDemoData();
    const fresh = loadStoredData();
    setTransactions(fresh.transactions);
    setCategories(fresh.categories);
    setAccounts(fresh.accounts);
    setInstallments(fresh.installments);
    setToastMessage('Dati demo ripristinati con successo.');
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Map category & account helper
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  return (
    <div className="min-h-screen bg-[#f5f6fb] dark:bg-[#0f1220] text-[#1c2030] dark:text-[#eef0f7] font-sans antialiased selection:bg-[#5566ff]/20 pb-16 transition-colors duration-200">
      {/* Top Header & Filters */}
      <Header
        period={period}
        onChangePeriod={setPeriod}
        scope={scope}
        onChangeScope={setScope}
        periodLabel={dateRange.label}
        onPrevPeriod={handlePrevPeriod}
        onNextPeriod={handleNextPeriod}
        onToday={handleToday}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onOpenQuickAdd={() => setIsQuickAddOpen(true)}
        onOpenDataModal={() => setIsDataModalOpen(true)}
      />

      {/* Main Container */}
      <main className="max-w-[1180px] mx-auto px-4 sm:px-6 pt-5 space-y-5">
        {/* Scheduled Due Payments Alert */}
        <FlashDueAlert
          installments={installments}
          onPayInstallment={handlePayInstallment}
        />

        {/* Hero Balance Summary & Financial KPIs */}
        <FlashBalanceSummary
          totalBalance={totalBalance}
          accounts={accountsWithBalance}
          period={period}
          periodIncome={periodSummary.income}
          periodExpense={periodSummary.expense}
          periodNet={periodSummary.net}
          insights={flashInsights}
          scope={scope}
          selectedAccountId={selectedAccountId}
          onSelectAccount={setSelectedAccountId}
          onOpenQuickAdd={() => setIsQuickAddOpen(true)}
          onOpenTxList={() => setIsTxListOpen(true)}
        />

        {/* Interactive Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Monthly Trend Bar Chart (Entrate vs Uscite) */}
          <div className="lg:col-span-7">
            <MonthlyTrendChart
              trendPoints={trendPoints}
              avgExpense={avgExpense}
              activeMonthKey={activeMonthKey}
              onSelectMonth={handleSelectMonthFromTrend}
              monthsCount={monthsCount}
              onChangeMonthsCount={setMonthsCount}
            />
          </div>

          {/* Interactive Category Donut Breakdown */}
          <div className="lg:col-span-5">
            <CategoryDonutChart
              categoriesData={categoryBreakdown}
              personalExpense={periodSummary.personalExpense}
              homeExpense={periodSummary.homeExpense}
              onSelectCategory={(catId) => {
                setSelectedCategoryId(catId || null);
                if (catId) setIsTxListOpen(true);
              }}
              selectedCategoryId={selectedCategoryId}
            />
          </div>
        </div>

        {/* Wealth Progression Curve (Evoluzione Patrimonio) */}
        <BalanceTrendChart
          trendPoints={trendPoints}
          currentTotalBalance={totalBalance}
        />

        {/* Recent Transactions Quick Preview */}
        <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-2">
                Ultimi Movimenti Registrati
                <span className="text-xs font-normal text-[#8a92a6] dark:text-[#7b839a]">
                  ({periodTransactions.length} nel periodo)
                </span>
              </h3>
              <p className="text-xs text-[#5b6478] dark:text-[#aab2c8]">
                {dateRange.label}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setIsTxListOpen(true)}
              className="text-xs font-semibold text-[#5566ff] dark:text-[#7c8dff] hover:underline cursor-pointer"
            >
              Vedi tutti e cerca →
            </button>
          </div>

          <div className="divide-y divide-[#e2e5f0] dark:divide-[#282d44]">
            {periodTransactions.slice(0, 5).map((t) => {
              const cat = categoryMap.get(t.categoryId || '');
              const acc = accountMap.get(t.accountId || '');
              const amountEur = centsToEuros(t.amount_cents);

              return (
                <div
                  key={t.id}
                  className="flex items-center justify-between py-2.5 px-1 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0 pr-2">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                        t.type === 'income'
                          ? 'bg-[#12b886]/10 text-[#12b886]'
                          : 'bg-[#e8546b]/10 text-[#e8546b]'
                      }`}
                    >
                      {t.type === 'income' ? (
                        <ArrowUpRight className="w-3.5 h-3.5 stroke-[2.5]" />
                      ) : (
                        <ArrowDownLeft className="w-3.5 h-3.5 stroke-[2.5]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-[#1c2030] dark:text-[#eef0f7] truncate">
                          {t.note || (t.type === 'income' ? 'Entrata' : 'Spesa')}
                        </span>
                        {t.isFixed && (
                          <span title="Spesa Fissa">
                            <Repeat className="w-2.5 h-2.5 text-[#5566ff] shrink-0" />
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10.5px] text-[#8a92a6] dark:text-[#7b839a]">
                        <span>{new Date(t.occurred_on).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
                        <span>·</span>
                        {cat && <span>{cat.name}</span>}
                        {acc && (
                          <>
                            <span>·</span>
                            <span>{acc.name}</span>
                          </>
                        )}
                        <span>·</span>
                        <span>{t.scope === 'home' ? '🏠 Casa' : '👤 Personale'}</span>
                      </div>
                    </div>
                  </div>

                  <span
                    className={`font-bold font-mono text-xs sm:text-sm shrink-0 ${
                      t.type === 'income' ? 'text-[#12b886]' : 'text-[#e8546b]'
                    }`}
                  >
                    {t.type === 'income' ? '+' : '-'}
                    {fmtEur(amountEur)}
                  </span>
                </div>
              );
            })}

            {periodTransactions.length === 0 && (
              <div className="py-6 text-center text-xs text-[#8a92a6] dark:text-[#7b839a]">
                Nessun movimento registrato in questo periodo. Usa il pulsante &quot;+ Flash&quot; per inserirne uno!
              </div>
            )}
          </div>
        </div>

        {/* Footer info & link to reference repo */}
        <footer className="pt-6 pb-2 text-center text-xs text-[#8a92a6] dark:text-[#7b839a] flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-[#e2e5f0] dark:border-[#282d44]">
          <div className="flex items-center gap-1.5">
            <span>Soldi Dashboard Flash</span>
            <span>·</span>
            <span>Web app spese & entrate personali</span>
          </div>
          <a
            href="https://github.com/mydohome/soldi"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[#5566ff] dark:text-[#7c8dff] hover:underline"
          >
            <span>Basato su github.com/mydohome/soldi</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </footer>
      </main>

      {/* Floating Action Button for mobile */}
      <div className="sm:hidden fixed bottom-5 right-5 z-40">
        <button
          type="button"
          onClick={() => setIsQuickAddOpen(true)}
          className="flex items-center justify-center w-14 h-14 rounded-full bg-[#5566ff] text-white shadow-xl active:scale-95 transition-transform"
          aria-label="Aggiungi movimento"
        >
          <Plus className="w-7 h-7 stroke-[2.5]" />
        </button>
      </div>

      {/* Modals */}
      <FlashQuickAddModal
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
        categories={categories}
        accounts={accounts}
        onAddTransaction={handleAddTransaction}
        defaultScope={scope}
      />

      <TransactionListModal
        isOpen={isTxListOpen}
        onClose={() => {
          setIsTxListOpen(false);
          setSelectedCategoryId(null);
        }}
        transactions={periodTransactions}
        categories={categories}
        accounts={accounts}
        onDeleteTransaction={handleDeleteTransaction}
        initialCategoryId={selectedCategoryId}
        periodLabel={dateRange.label}
      />

      <DataManagementModal
        isOpen={isDataModalOpen}
        onClose={() => setIsDataModalOpen(false)}
        transactions={transactions}
        categories={categories}
        accounts={accounts}
        onImportTransactions={handleImportTransactions}
        onResetDemo={handleResetDemo}
      />

      {/* Toast Notification with Undo */}
      {toastMessage && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-[#1c2030] dark:bg-[#1e2236] text-white px-4 py-2.5 rounded-2xl shadow-2xl border border-white/10 text-xs flex items-center gap-3 animate-in slide-in-from-bottom duration-200">
          <span>{toastMessage}</span>
          {lastDeletedTx && (
            <button
              type="button"
              onClick={handleUndoDelete}
              className="font-bold text-amber-300 hover:text-amber-200 flex items-center gap-1 cursor-pointer pl-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Annulla</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
