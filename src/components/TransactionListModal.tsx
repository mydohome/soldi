import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Filter,
  Repeat,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Account, Category, Transaction, TransactionType } from '../types';
import { centsToEuros, fmtEur } from '../utils/calculations';
import { exportTransactionsToCsv } from '../utils/storage';

interface TransactionListModalProps {
  isOpen: boolean;
  onClose: () => void;
  transactions: Transaction[];
  categories: Category[];
  accounts: Account[];
  onDeleteTransaction: (id: string) => void;
  initialCategoryId?: string | null;
  initialType?: TransactionType | 'all';
  periodLabel: string;
}

export const TransactionListModal: React.FC<TransactionListModalProps> = ({
  isOpen,
  onClose,
  transactions,
  categories,
  accounts,
  onDeleteTransaction,
  initialCategoryId,
  initialType = 'all',
  periodLabel,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<TransactionType | 'all'>(initialType);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(initialCategoryId || null);

  React.useEffect(() => {
    if (isOpen) {
      setTypeFilter(initialType);
      setSelectedCatId(initialCategoryId || null);
    }
  }, [isOpen, initialType, initialCategoryId]);

  if (!isOpen) return null;

  const catMap = new Map(categories.map((c) => [c.id, c]));
  const accMap = new Map(accounts.map((a) => [a.id, a]));

  const filtered = transactions.filter((t) => {
    if (typeFilter !== 'all' && t.type !== typeFilter) return false;
    if (selectedCatId && t.categoryId !== selectedCatId) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const noteMatch = (t.note || '').toLowerCase().includes(q);
      const catName = (catMap.get(t.categoryId || '')?.name || '').toLowerCase();
      const accName = (accMap.get(t.accountId || '')?.name || '').toLowerCase();
      if (!noteMatch && !catName.includes(q) && !accName.includes(q)) return false;
    }
    return true;
  });

  const handleExportCsv = () => {
    const csv = exportTransactionsToCsv(filtered, categories, accounts);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `soldi_movimenti_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] w-full max-w-2xl rounded-3xl p-6 shadow-2xl flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#e2e5f0] dark:border-[#282d44] shrink-0">
          <div>
            <h2 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-2">
              Movimenti
              <span className="text-xs font-normal text-[#8a92a6] dark:text-[#7b839a]">
                ({filtered.length} di {transactions.length}) · {periodLabel}
              </span>
            </h2>
            <p className="text-xs text-[#5b6478] dark:text-[#aab2c8]">
              Cerca, filtra ed esporta in CSV
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-1.5 text-xs font-semibold bg-[#eef0f7] dark:bg-[#1e2236] hover:bg-[#e2e5f0] text-[#1c2030] dark:text-[#eef0f7] px-3 py-1.5 rounded-xl transition-colors cursor-pointer"
              title="Esporta in CSV"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-[#8a92a6] dark:text-[#7b839a] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filters & Search */}
        <div className="py-3 space-y-2 shrink-0 border-b border-[#e2e5f0] dark:border-[#282d44]">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-[#8a92a6] absolute left-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                placeholder="Cerca per nota, categoria, conto..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full text-xs pl-9 pr-3 py-2 bg-slate-50 dark:bg-[#1e2236] border border-[#e2e5f0] dark:border-[#282d44] rounded-xl text-[#1c2030] dark:text-[#eef0f7] focus:outline-none focus:ring-1 focus:ring-[#5566ff]"
              />
            </div>
            {/* Type buttons */}
            <div className="flex items-center gap-1 bg-[#eef0f7] dark:bg-[#1e2236] p-1 rounded-xl shrink-0">
              <button
                type="button"
                onClick={() => setTypeFilter('all')}
                className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                  typeFilter === 'all'
                    ? 'bg-white dark:bg-[#282d44] font-bold text-[#1c2030] dark:text-[#eef0f7] shadow-xs'
                    : 'text-[#5b6478] dark:text-[#aab2c8]'
                }`}
              >
                Tutti
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter('expense')}
                className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                  typeFilter === 'expense'
                    ? 'bg-white dark:bg-[#282d44] font-bold text-[#e8546b] shadow-xs'
                    : 'text-[#5b6478] dark:text-[#aab2c8]'
                }`}
              >
                Uscite
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter('income')}
                className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                  typeFilter === 'income'
                    ? 'bg-white dark:bg-[#282d44] font-bold text-[#12b886] shadow-xs'
                    : 'text-[#5b6478] dark:text-[#aab2c8]'
                }`}
              >
                Entrate
              </button>
            </div>
          </div>

          {selectedCatId && (
            <div className="flex items-center gap-2 text-xs text-[#5566ff] bg-[#5566ff]/10 px-3 py-1.5 rounded-xl">
              <span>Filtro categoria attivo: <strong>{catMap.get(selectedCatId)?.name}</strong></span>
              <button
                type="button"
                onClick={() => setSelectedCatId(null)}
                className="text-xs hover:underline ml-auto font-medium"
              >
                Rimuovi filtro
              </button>
            </div>
          )}
        </div>

        {/* Transactions List */}
        <div className="overflow-y-auto flex-1 divide-y divide-[#e2e5f0] dark:divide-[#282d44] pr-1 py-1">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-[#8a92a6] dark:text-[#7b839a]">
              Nessun movimento trovato per i filtri selezionati.
            </div>
          ) : (
            filtered.map((t) => {
              const cat = catMap.get(t.categoryId || '');
              const acc = accMap.get(t.accountId || '');
              const amountEur = centsToEuros(t.amount_cents);

              return (
                <div
                  key={t.id}
                  className="flex items-center justify-between py-3 px-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0 pr-2">
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        t.type === 'income'
                          ? 'bg-[#12b886]/10 text-[#12b886]'
                          : 'bg-[#e8546b]/10 text-[#e8546b]'
                      }`}
                    >
                      {t.type === 'income' ? (
                        <ArrowUpRight className="w-4 h-4 stroke-[2.5]" />
                      ) : (
                        <ArrowDownLeft className="w-4 h-4 stroke-[2.5]" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs sm:text-sm text-[#1c2030] dark:text-[#eef0f7] truncate">
                          {t.note || (t.type === 'income' ? 'Entrata' : 'Spesa')}
                        </span>
                        {t.isFixed && (
                          <span
                            title="Spesa Fissa Ricorrente"
                            className="inline-flex items-center text-[#5566ff] dark:text-[#7c8dff]"
                          >
                            <Repeat className="w-3 h-3" />
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-[11px] text-[#8a92a6] dark:text-[#7b839a] mt-0.5">
                        <span>{new Date(t.occurred_on).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
                        <span>·</span>
                        {cat && (
                          <span className="flex items-center gap-1">
                            <span
                              className="w-2 h-2 rounded-full inline-block"
                              style={{ backgroundColor: cat.color }}
                            />
                            {cat.name}
                          </span>
                        )}
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

                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`font-bold font-mono text-xs sm:text-sm ${
                        t.type === 'income' ? 'text-[#12b886]' : 'text-[#e8546b]'
                      }`}
                    >
                      {t.type === 'income' ? '+' : '-'}
                      {fmtEur(amountEur)}
                    </span>

                    <button
                      type="button"
                      onClick={() => onDeleteTransaction(t.id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-[#8a92a6] hover:text-[#e8546b] hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-all cursor-pointer"
                      title="Elimina movimento"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
