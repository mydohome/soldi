import React from 'react';
import { AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { PaymentInstallment } from '../types';
import { fmtEur } from '../utils/calculations';

interface FlashDueAlertProps {
  installments: PaymentInstallment[];
  onPayInstallment: (installment: PaymentInstallment) => void;
}

export const FlashDueAlert: React.FC<FlashDueAlertProps> = ({
  installments,
  onPayInstallment,
}) => {
  const pending = installments.filter((i) => !i.paid);
  if (pending.length === 0) return null;

  return (
    <div className="bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 rounded-2xl p-4 transition-all">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs uppercase tracking-wide">
          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          <span>Da Pagare · Scadenze in Arrivo ({pending.length})</span>
        </div>
        <span className="text-[11px] text-amber-700/80 dark:text-amber-400/80">
          Tocca &quot;Paga&quot; per registrare il movimento
        </span>
      </div>

      <div className="space-y-2">
        {pending.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between bg-white dark:bg-[#1a1f33] p-2.5 px-3.5 rounded-xl border border-amber-200 dark:border-amber-900/40 text-xs shadow-2xs"
          >
            <div className="min-w-0 pr-2">
              <span className="font-semibold text-[#1c2030] dark:text-[#eef0f7] block truncate">
                {item.planName}
              </span>
              <span className="text-[11px] text-[#8a92a6] dark:text-[#7b839a]">
                Scadenza: {new Date(item.due_on).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} ·{' '}
                {item.scope === 'home' ? '🏠 Casa' : '👤 Personale'}
              </span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <span className="font-bold text-sm text-[#1c2030] dark:text-[#eef0f7]">
                {fmtEur(item.amount_cents / 100)}
              </span>
              <button
                type="button"
                onClick={() => onPayInstallment(item)}
                className="flex items-center gap-1 bg-[#12b886] hover:bg-[#0ea577] active:scale-95 text-white font-medium px-3 py-1.5 rounded-lg transition-all cursor-pointer shadow-xs"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Paga</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
