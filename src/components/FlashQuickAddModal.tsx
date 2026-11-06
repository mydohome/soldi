import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, Sparkles, Target, X } from 'lucide-react';
import { Account, Category, Transaction, TransactionScope, TransactionType } from '../types';
import { eurosToCents, fmtEur } from '../utils/calculations';
import { buildSuggestions } from '../utils/suggest';

interface FlashQuickAddModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  accounts: Account[];
  transactions: Transaction[];
  onAddTransaction: (tx: Omit<Transaction, 'id'>) => void;
  defaultScope?: TransactionScope | 'all';
}

export const FlashQuickAddModal: React.FC<FlashQuickAddModalProps> = ({
  isOpen,
  onClose,
  categories,
  accounts,
  transactions,
  onAddTransaction,
  defaultScope,
}) => {
  const [type, setType] = useState<TransactionType>('expense');
  const [amountInput, setAmountInput] = useState('');
  const [scope, setScope] = useState<TransactionScope>(
    defaultScope === 'home' ? 'home' : 'personal'
  );
  const [categoryId, setCategoryId] = useState<string>('cat-alimentari');
  const [accountId, setAccountId] = useState<string>('acc-carta');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [isFixed, setIsFixed] = useState(false);

  // Track if user explicitly touched category or account selector
  const [catTouched, setCatTouched] = useState(false);
  const [accTouched, setAccTouched] = useState(false);

  // Reset touched on modal open
  useEffect(() => {
    if (isOpen) {
      setCatTouched(false);
      setAccTouched(false);
      setNote('');
      setAmountInput('');
    }
  }, [isOpen]);

  const filteredCategories = useMemo(
    () => categories.filter((c) => c.kind === type),
    [categories, type]
  );

  // Compute suggestions in real-time from past transaction history
  const suggestions = useMemo(() => {
    return buildSuggestions({
      transactions,
      note,
      type,
      scope,
      categories,
      accounts,
    });
  }, [transactions, note, type, scope, categories, accounts]);

  // Auto-apply suggested category/account if user hasn't manually touched them
  useEffect(() => {
    if (suggestions.category && !catTouched) {
      setCategoryId(suggestions.category.id);
    }
  }, [suggestions.category, catTouched]);

  useEffect(() => {
    if (suggestions.account && !accTouched) {
      setAccountId(suggestions.account.id);
    }
  }, [suggestions.account, accTouched]);

  // Keep category valid for active type
  useEffect(() => {
    if (filteredCategories.length > 0 && !filteredCategories.find((c) => c.id === categoryId)) {
      setCategoryId(filteredCategories[0].id);
    }
  }, [filteredCategories, categoryId]);

  if (!isOpen) return null;

  const numAmount = parseFloat(amountInput.replace(',', '.'));
  const isValid = !isNaN(numAmount) && numAmount > 0;

  const handleApplySuggestion = () => {
    if (suggestions.category) {
      setCategoryId(suggestions.category.id);
      setCatTouched(true);
    }
    if (suggestions.account) {
      setAccountId(suggestions.account.id);
      setAccTouched(true);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    onAddTransaction({
      type,
      amount_cents: eurosToCents(numAmount),
      categoryId,
      accountId,
      scope,
      note: note.trim() || (type === 'income' ? 'Entrata' : 'Spesa'),
      occurred_on: date,
      isFixed,
    });

    onClose();
  };

  const activeCategoryMeta = categories.find((c) => c.id === categoryId);
  const activeAccountMeta = accounts.find((a) => a.id === accountId);

  // Check if suggestion differs from current selection
  const showSuggestionNotice =
    (suggestions.category && suggestions.category.id !== categoryId) ||
    (suggestions.account && suggestions.account.id !== accountId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] w-full max-w-md rounded-3xl p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#e2e5f0] dark:border-[#282d44]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#5566ff]/10 text-[#5566ff] flex items-center justify-center font-bold">
              ⚡
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7]">
                Movimento Flash
              </h2>
              <p className="text-xs text-[#8a92a6] dark:text-[#7b839a]">
                Suggerimenti intelligenti basati sullo storico
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-[#8a92a6] dark:text-[#7b839a] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 pt-3">
          {/* Type Toggle: Spesa vs Entrata */}
          <div className="grid grid-cols-2 gap-2 bg-[#eef0f7] dark:bg-[#1e2236] p-1 rounded-2xl">
            <button
              type="button"
              onClick={() => {
                setType('expense');
                setCatTouched(false);
              }}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                type === 'expense'
                  ? 'bg-white dark:bg-[#282d44] text-[#e8546b] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8] hover:text-[#1c2030]'
              }`}
            >
              <ArrowDownLeft className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Uscita / Spesa</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setType('income');
                setCatTouched(false);
              }}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                type === 'income'
                  ? 'bg-white dark:bg-[#282d44] text-[#12b886] shadow-xs'
                  : 'text-[#5b6478] dark:text-[#aab2c8] hover:text-[#1c2030]'
              }`}
            >
              <ArrowUpRight className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Entrata</span>
            </button>
          </div>

          {/* Amount Large Input */}
          <div className="text-center py-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[#8a92a6] dark:text-[#7b839a] block mb-1">
              Importo (€)
            </label>
            <div className="relative inline-flex items-center justify-center max-w-[280px] mx-auto">
              <span className="text-2xl font-bold text-[#8a92a6] dark:text-[#7b839a] mr-1.5">
                €
              </span>
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                placeholder="0,00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className={`w-full text-center text-3xl font-extrabold bg-transparent border-b-2 focus:outline-none transition-colors ${
                  type === 'expense'
                    ? 'text-[#e8546b] border-[#e8546b]/30 focus:border-[#e8546b]'
                    : 'text-[#12b886] border-[#12b886]/30 focus:border-[#12b886]'
                }`}
              />
            </div>
            {isValid && (
              <p className="text-xs text-[#5b6478] dark:text-[#aab2c8] mt-1 font-mono">
                Totale: {fmtEur(numAmount)}
              </p>
            )}
          </div>

          {/* Note / Descrizione (with smart suggestion) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-[#8a92a6] dark:text-[#7b839a]">
                Descrizione / Nota
              </label>
              {suggestions.descriptions.length > 0 && (
                <span className="text-[10px] text-[#5566ff] dark:text-[#7c8dff]">
                  {suggestions.descriptions.length} suggerimenti dallo storico
                </span>
              )}
            </div>

            <input
              type="text"
              placeholder="es. Spesa Esselunga, Pranzo, Benzina, Stipendio"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full text-xs bg-slate-50 dark:bg-[#1e2236] border border-[#e2e5f0] dark:border-[#282d44] rounded-xl px-3 py-2.5 text-[#1c2030] dark:text-[#eef0f7] focus:outline-none focus:ring-1 focus:ring-[#5566ff]"
            />

            {/* Soldi Signature Suggestion Line */}
            {showSuggestionNotice && (
              <div className="mt-2 flex items-center justify-between bg-[#5566ff]/10 dark:bg-[#5566ff]/15 border border-[#5566ff]/25 rounded-xl px-2.5 py-1.5 text-xs text-[#1c2030] dark:text-[#eef0f7]">
                <div className="flex items-center gap-1.5 min-w-0 pr-1 text-[11.5px]">
                  <Target className="w-3.5 h-3.5 text-[#5566ff] shrink-0" />
                  <span className="text-[#5566ff] font-semibold shrink-0">Suggerito:</span>
                  {suggestions.category && (
                    <span className="inline-flex items-center gap-1 truncate font-medium">
                      <span
                        className="w-2 h-2 rounded-full inline-block shrink-0"
                        style={{ backgroundColor: suggestions.category.color }}
                      />
                      {suggestions.category.name}
                    </span>
                  )}
                  {suggestions.category && suggestions.account && <span>·</span>}
                  {suggestions.account && (
                    <span className="inline-flex items-center gap-1 truncate font-medium">
                      <span
                        className="w-2 h-2 rounded-full inline-block shrink-0"
                        style={{ backgroundColor: suggestions.account.color }}
                      />
                      {suggestions.account.name}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleApplySuggestion}
                  className="bg-[#5566ff] text-white hover:bg-[#4856ea] px-2 py-0.5 rounded-lg text-[11px] font-semibold shrink-0 cursor-pointer shadow-xs"
                >
                  Applica
                </button>
              </div>
            )}

            {/* Quick autocomplete chips from past transactions */}
            {suggestions.descriptions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {suggestions.descriptions.slice(0, 4).map((desc) => (
                  <button
                    key={desc}
                    type="button"
                    onClick={() => {
                      setNote(desc);
                      setCatTouched(false);
                      setAccTouched(false);
                    }}
                    className="text-[10.5px] bg-[#eef0f7] dark:bg-[#1e2236] hover:bg-[#e2e5f0] text-[#5b6478] dark:text-[#aab2c8] px-2 py-0.5 rounded-lg transition-colors cursor-pointer truncate max-w-[140px]"
                  >
                    {desc}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Scope Toggle: Personale vs Casa */}
          <div>
            <label className="text-[11px] font-semibold text-[#8a92a6] dark:text-[#7b839a] block mb-1">
              Ambito
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScope('personal')}
                className={`py-1.5 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                  scope === 'personal'
                    ? 'border-[#5566ff] bg-[#5566ff]/10 text-[#5566ff] dark:text-[#7c8dff]'
                    : 'border-[#e2e5f0] dark:border-[#282d44] text-[#5b6478] dark:text-[#aab2c8]'
                }`}
              >
                👤 Personale
              </button>
              <button
                type="button"
                onClick={() => setScope('home')}
                className={`py-1.5 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                  scope === 'home'
                    ? 'border-[#f4a259] bg-[#f4a259]/10 text-[#f4a259]'
                    : 'border-[#e2e5f0] dark:border-[#282d44] text-[#5b6478] dark:text-[#aab2c8]'
                }`}
              >
                🏠 Casa
              </button>
            </div>
          </div>

          {/* Category Selection */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-[#8a92a6] dark:text-[#7b839a]">
                Categoria
              </label>
              {activeCategoryMeta && (
                <span className="text-[11px] font-medium text-[#1c2030] dark:text-[#eef0f7]">
                  Selezionata: <strong>{activeCategoryMeta.name}</strong>
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-32 overflow-y-auto p-1 border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl">
              {filteredCategories.map((c) => {
                const isSel = categoryId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setCategoryId(c.id);
                      setCatTouched(true);
                    }}
                    className={`flex items-center gap-1.5 p-2 rounded-xl text-xs text-left transition-all cursor-pointer ${
                      isSel
                        ? 'bg-slate-100 dark:bg-slate-800 font-bold ring-1 ring-inset ring-[#5566ff]'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-[#1c2030] dark:text-[#eef0f7]'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Account & Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-[#8a92a6] dark:text-[#7b839a] block mb-1">
                Conto
              </label>
              <select
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setAccTouched(true);
                }}
                className="w-full text-xs bg-slate-50 dark:bg-[#1e2236] border border-[#e2e5f0] dark:border-[#282d44] rounded-xl px-2.5 py-2 text-[#1c2030] dark:text-[#eef0f7] focus:outline-none focus:ring-1 focus:ring-[#5566ff]"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-[#8a92a6] dark:text-[#7b839a] block mb-1">
                Data
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full text-xs bg-slate-50 dark:bg-[#1e2236] border border-[#e2e5f0] dark:border-[#282d44] rounded-xl px-2.5 py-2 text-[#1c2030] dark:text-[#eef0f7] focus:outline-none focus:ring-1 focus:ring-[#5566ff]"
              />
            </div>
          </div>

          {/* Fixed Expense Checkbox */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isFixedTx"
              checked={isFixed}
              onChange={(e) => setIsFixed(e.target.checked)}
              className="w-4 h-4 rounded text-[#5566ff] focus:ring-0 cursor-pointer"
            />
            <label htmlFor="isFixedTx" className="text-xs text-[#5b6478] dark:text-[#aab2c8] cursor-pointer">
              Segna come <strong>spesa fissa / ricorrente</strong> (mutuo, abbonamento, rata)
            </label>
          </div>

          {/* Submit CTA */}
          <button
            type="submit"
            disabled={!isValid}
            className={`w-full py-3 rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2 shadow-md transition-all cursor-pointer ${
              isValid
                ? 'bg-[#5566ff] hover:bg-[#4856ea] active:scale-[0.98]'
                : 'bg-slate-300 dark:bg-slate-700 cursor-not-allowed opacity-60'
            }`}
          >
            <Check className="w-4 h-4 stroke-[3]" />
            <span>Salva Movimento Flash</span>
          </button>
        </form>
      </div>
    </div>
  );
};
