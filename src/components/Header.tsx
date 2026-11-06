import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  User,
  Home,
  Layers,
} from 'lucide-react';
import { PeriodType, TransactionScope } from '../types';

interface HeaderProps {
  period: PeriodType;
  onChangePeriod: (p: PeriodType) => void;
  scope: TransactionScope | 'all';
  onChangeScope: (s: TransactionScope | 'all') => void;
  periodLabel: string;
  onPrevPeriod: () => void;
  onNextPeriod: () => void;
  onToday: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenQuickAdd: () => void;
  onOpenDataModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  period,
  onChangePeriod,
  scope,
  onChangeScope,
  periodLabel,
  onPrevPeriod,
  onNextPeriod,
  onToday,
  theme,
  onToggleTheme,
  onOpenQuickAdd,
  onOpenDataModal,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-white/90 dark:bg-[#0f1220]/90 backdrop-blur-md border-b border-[#e2e5f0] dark:border-[#282d44] transition-colors">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-3">
        {/* Top bar: Brand & Actions */}
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-[#5566ff] text-white flex items-center justify-center font-bold text-lg shadow-sm">
              💸
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-base tracking-tight text-[#1c2030] dark:text-[#eef0f7]">
                  Soldi
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider bg-[#5566ff]/10 text-[#5566ff] dark:text-[#7c8dff] px-1.5 py-0.2 rounded">
                  Flash
                </span>
              </div>
              <span className="text-[11px] text-[#8a92a6] dark:text-[#7b839a] hidden sm:inline">
                Spese, saldi & andamento
              </span>
            </div>
          </div>

          {/* Quick Right Utilities */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={onOpenDataModal}
              className="p-2 rounded-xl text-[#5b6478] dark:text-[#aab2c8] hover:bg-[#eef0f7] dark:hover:bg-[#1e2236] transition-colors cursor-pointer"
              title="Dati & Backup CSV"
            >
              <Database className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onToggleTheme}
              className="p-2 rounded-xl text-[#5b6478] dark:text-[#aab2c8] hover:bg-[#eef0f7] dark:hover:bg-[#1e2236] transition-colors cursor-pointer"
              title={theme === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onOpenQuickAdd}
              className="flex items-center gap-1.5 bg-[#5566ff] hover:bg-[#4856ea] active:scale-95 text-white font-semibold text-xs sm:text-sm px-3.5 py-2 rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span className="hidden sm:inline">Nuovo Movimento</span>
              <span className="sm:hidden">+ Flash</span>
            </button>
          </div>
        </div>

        {/* Bottom controls: Period Tabs, Scope Segment, and Date Navigation */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1 text-xs">
          {/* Period selector: Giorno / Settimana / Mese */}
          <div className="flex items-center bg-[#eef0f7] dark:bg-[#1e2236] p-0.5 rounded-xl">
            <button
              type="button"
              onClick={() => onChangePeriod('day')}
              className={`px-3 py-1.5 font-medium rounded-lg transition-all ${
                period === 'day'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#1c2030] dark:text-[#eef0f7] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              Giorno
            </button>
            <button
              type="button"
              onClick={() => onChangePeriod('week')}
              className={`px-3 py-1.5 font-medium rounded-lg transition-all ${
                period === 'week'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#1c2030] dark:text-[#eef0f7] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              Settimana
            </button>
            <button
              type="button"
              onClick={() => onChangePeriod('month')}
              className={`px-3 py-1.5 font-medium rounded-lg transition-all ${
                period === 'month'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#1c2030] dark:text-[#eef0f7] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              Mese
            </button>
          </div>

          {/* Scope Segment: Tutti / Personale / Casa */}
          <div className="flex items-center bg-[#eef0f7] dark:bg-[#1e2236] p-0.5 rounded-xl">
            <button
              type="button"
              onClick={() => onChangeScope('all')}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium rounded-lg transition-all ${
                scope === 'all'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#1c2030] dark:text-[#eef0f7] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              <Layers className="w-3 h-3" />
              <span>Tutti</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeScope('personal')}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium rounded-lg transition-all ${
                scope === 'personal'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#5566ff] dark:text-[#7c8dff] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              <User className="w-3 h-3" />
              <span>Personale</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeScope('home')}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium rounded-lg transition-all ${
                scope === 'home'
                  ? 'bg-white dark:bg-[#282d44] font-bold text-[#f4a259] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8]'
              }`}
            >
              <Home className="w-3 h-3" />
              <span>Casa</span>
            </button>
          </div>

          {/* Period Navigator (< Label > Oggi) */}
          <div className="flex items-center gap-1 text-[#1c2030] dark:text-[#eef0f7] bg-[#f5f6fb] dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] px-1 py-0.5 rounded-xl">
            <button
              type="button"
              onClick={onPrevPeriod}
              className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              aria-label="Periodo precedente"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span className="font-semibold px-2 min-w-[130px] text-center select-none truncate">
              {periodLabel}
            </span>

            <button
              type="button"
              onClick={onNextPeriod}
              className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              aria-label="Periodo successivo"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onToday}
              className="px-2 py-0.5 ml-1 text-[11px] font-semibold text-[#5566ff] hover:bg-[#5566ff]/10 rounded-lg transition-colors cursor-pointer"
            >
              Oggi
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
