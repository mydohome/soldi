import React from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Calendar,
  CreditCard,
  Landmark,
  PiggyBank,
  Plus,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import { Account, FlashInsights, PeriodType, TransactionScope } from '../types';
import { fmtEur } from '../utils/calculations';

interface FlashBalanceSummaryProps {
  totalBalance: number;
  accounts: Array<Account & { currentBalance: number; expenseTotal: number; incomeTotal: number }>;
  period: PeriodType;
  periodIncome: number;
  periodExpense: number;
  periodNet: number;
  insights: FlashInsights;
  scope: TransactionScope | 'all';
  selectedAccountId: string | null;
  onSelectAccount: (accountId: string | null) => void;
  onOpenQuickAdd: () => void;
  onOpenTxList: () => void;
}

export const FlashBalanceSummary: React.FC<FlashBalanceSummaryProps> = ({
  totalBalance,
  accounts,
  period,
  periodIncome,
  periodExpense,
  periodNet,
  insights,
  scope,
  selectedAccountId,
  onSelectAccount,
  onOpenQuickAdd,
  onOpenTxList,
}) => {
  const periodLabel = period === 'day' ? 'del giorno' : period === 'week' ? 'della settimana' : 'del mese';

  // Helper to pick account icon
  const getAccountIcon = (kind: Account['kind']) => {
    switch (kind) {
      case 'bank':
        return <Landmark className="w-4 h-4" />;
      case 'card':
        return <CreditCard className="w-4 h-4" />;
      case 'cash':
        return <Banknote className="w-4 h-4" />;
      case 'savings':
        return <PiggyBank className="w-4 h-4" />;
      default:
        return <Wallet className="w-4 h-4" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Hero Card: Saldo Attuale & Flusso del Periodo */}
      <div className="relative overflow-hidden bg-gradient-to-br from-[#5566ff] via-[#4856ea] to-[#3944cb] dark:from-[#353e99] dark:via-[#262c6d] dark:to-[#171a3e] rounded-3xl p-6 sm:p-7 text-white shadow-lg">
        {/* Decorative background wave svg */}
        <div className="absolute -right-12 -bottom-16 w-80 h-80 opacity-10 pointer-events-none select-none">
          <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" className="w-full h-full fill-current">
            <path
              d="M44.7,-76.4C58.8,-69.2,71.8,-59.1,79.6,-45.8C87.4,-32.6,90,-16.3,88.5,-0.9C86.9,14.6,81.2,29.1,72.6,41.4C63.9,53.7,52.3,63.7,39.1,70.9C25.8,78.1,10.9,82.4,-3.6,88.6C-18.1,94.9,-32.2,103.1,-44.6,98.6C-57,94,-67.7,76.6,-74.6,60.8C-81.5,45,-84.6,30.8,-86.2,16.5C-87.7,2.2,-87.7,-12.3,-82.9,-25.1C-78.1,-37.9,-68.5,-49.1,-56.4,-57C-44.2,-64.9,-29.5,-69.6,-14.8,-71.4C-0.1,-73.2,14.6,-72,44.7,-76.4Z"
              transform="translate(100 100)"
            />
          </svg>
        </div>

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          {/* Left: Current Balance */}
          <div>
            <div className="flex items-center gap-2 text-white/80 text-xs font-semibold uppercase tracking-wider mb-1">
              <Zap className="w-3.5 h-3.5 text-yellow-300" />
              <span>Riepilogo Rapido · Saldo Attuale</span>
              {scope !== 'all' && (
                <span className="bg-white/20 px-2 py-0.5 rounded-full text-[10px] normal-case tracking-normal">
                  {scope === 'personal' ? '👤 Personale' : '🏠 Casa'}
                </span>
              )}
            </div>

            <div className="flex items-baseline gap-3">
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                {fmtEur(totalBalance)}
              </h1>
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1 ${
                  periodNet >= 0
                    ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/30'
                    : 'bg-rose-500/25 text-rose-200 border border-rose-400/30'
                }`}
              >
                {periodNet >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {periodNet >= 0 ? '+' : ''}
                {fmtEur(periodNet)} {periodLabel}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-white/85">
              <div className="flex items-center gap-1.5 bg-black/15 px-3 py-1 rounded-full">
                <ArrowUpRight className="w-3.5 h-3.5 text-emerald-300" />
                <span>Entrate: <strong>{fmtEur(periodIncome)}</strong></span>
              </div>
              <div className="flex items-center gap-1.5 bg-black/15 px-3 py-1 rounded-full">
                <ArrowDownRight className="w-3.5 h-3.5 text-rose-300" />
                <span>Uscite: <strong>{fmtEur(periodExpense)}</strong></span>
              </div>
              <div className="hidden sm:flex items-center gap-1.5 text-white/70">
                <span>Tasso risparmio: <strong className="text-white">{insights.savingsRate}%</strong></span>
              </div>
            </div>
          </div>

          {/* Right: Quick Action Buttons */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onOpenQuickAdd}
              className="flex items-center gap-2 bg-white text-[#5566ff] hover:bg-slate-50 active:scale-95 font-semibold text-sm px-4 py-2.5 rounded-2xl shadow-md transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>Movimento Flash</span>
            </button>
            <button
              type="button"
              onClick={onOpenTxList}
              className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 active:scale-95 text-white font-medium text-xs sm:text-sm px-3.5 py-2.5 rounded-2xl transition-all cursor-pointer border border-white/20"
            >
              <span>Vedi Lista</span>
            </button>
          </div>
        </div>
      </div>

      {/* Account Balances Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {accounts.map((acc) => {
          const isSelected = selectedAccountId === acc.id;

          return (
            <div
              key={acc.id}
              onClick={() => onSelectAccount(isSelected ? null : acc.id)}
              className={`p-3.5 rounded-2xl border transition-all cursor-pointer select-none ${
                isSelected
                  ? 'bg-white dark:bg-[#1e2236] border-[#5566ff] shadow-md ring-2 ring-[#5566ff]/20'
                  : 'bg-white dark:bg-[#171a2b] border-[#e2e5f0] dark:border-[#282d44] hover:border-[#5566ff]/50 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded-xl flex items-center justify-center text-white"
                    style={{ backgroundColor: acc.color }}
                  >
                    {getAccountIcon(acc.kind)}
                  </div>
                  <span className="text-xs font-semibold text-[#1c2030] dark:text-[#eef0f7] truncate">
                    {acc.name}
                  </span>
                </div>
                {isSelected && (
                  <span className="text-[10px] font-bold text-[#5566ff] bg-[#5566ff]/10 px-1.5 py-0.5 rounded">
                    Attivo
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-between">
                <span className="text-base sm:text-lg font-bold text-[#1c2030] dark:text-[#eef0f7]">
                  {fmtEur(acc.currentBalance)}
                </span>
              </div>

              <div className="flex justify-between items-center text-[11px] text-[#8a92a6] dark:text-[#7b839a] mt-1 pt-1.5 border-t border-slate-100 dark:border-slate-800">
                <span>Uscite: {fmtEur(acc.expenseTotal)}</span>
                <span className="text-[#12b886]">+{fmtEur(acc.incomeTotal)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 4 Flash Insights Indicators */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
        <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] p-3 rounded-2xl">
          <span className="text-[11px] font-medium text-[#8a92a6] dark:text-[#7b839a] block">
            Media al giorno
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7]">
              {fmtEur(insights.dailyAvgExpense)}
            </span>
            <span className="text-[10px] text-[#5b6478] dark:text-[#aab2c8]">
              /gg
            </span>
          </div>
          <span className="text-[10px] text-[#8a92a6] dark:text-[#7b839a] truncate block mt-0.5">
            Escl. fisse: {fmtEur(insights.dailyAvgExcludingFixed)}
          </span>
        </div>

        <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] p-3 rounded-2xl">
          <span className="text-[11px] font-medium text-[#8a92a6] dark:text-[#7b839a] block">
            Picco di spesa
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-base font-bold text-[#e8546b]">
              {insights.highestExpense ? fmtEur(insights.highestExpense.amount) : '€0'}
            </span>
          </div>
          <span className="text-[10px] text-[#5b6478] dark:text-[#aab2c8] truncate block mt-0.5">
            {insights.highestExpense ? insights.highestExpense.note : 'Nessuna spesa'}
          </span>
        </div>

        <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] p-3 rounded-2xl">
          <span className="text-[11px] font-medium text-[#8a92a6] dark:text-[#7b839a] block">
            Stima fine mese
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7]">
              {fmtEur(insights.projectedMonthEndExpense)}
            </span>
          </div>
          <span className="text-[10px] text-[#8a92a6] dark:text-[#7b839a] truncate block mt-0.5">
            Proiezione uscite
          </span>
        </div>

        <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] p-3 rounded-2xl">
          <span className="text-[11px] font-medium text-[#8a92a6] dark:text-[#7b839a] block">
            Peso Spese Fisse
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-base font-bold text-[#5566ff] dark:text-[#7c8dff]">
              {insights.fixedExpensesShare}%
            </span>
          </div>
          <span className="text-[10px] text-[#8a92a6] dark:text-[#7b839a] truncate block mt-0.5">
            Delle uscite totali
          </span>
        </div>
      </div>
    </div>
  );
};
