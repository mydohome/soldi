import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Database,
  Download,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { Account, Category, Transaction } from '../types';
import { exportTransactionsToCsv, parseCsvTransactions } from '../utils/storage';

interface DataManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  transactions: Transaction[];
  categories: Category[];
  accounts: Account[];
  onImportTransactions: (txs: Transaction[]) => void;
  onResetDemo: () => void;
}

export const DataManagementModal: React.FC<DataManagementModalProps> = ({
  isOpen,
  onClose,
  transactions,
  categories,
  accounts,
  onImportTransactions,
  onResetDemo,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleExport = () => {
    const csv = exportTransactionsToCsv(transactions, categories, accounts);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soldi_backup_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = parseCsvTransactions(text, categories, accounts);
        if (parsed.length > 0) {
          onImportTransactions(parsed);
          setImportStatus(`Importati con successo ${parsed.length} movimenti!`);
        } else {
          setImportStatus('Nessun movimento valido trovato nel file CSV.');
        }
      } catch (err) {
        console.error(err);
        setImportStatus('Errore nella lettura del file CSV.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] w-full max-w-md rounded-3xl p-6 shadow-2xl relative"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between pb-3 border-b border-[#e2e5f0] dark:border-[#282d44]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#5566ff]/10 text-[#5566ff] flex items-center justify-center font-bold">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7]">
                Gestione Dati & Backup
              </h2>
              <p className="text-xs text-[#8a92a6] dark:text-[#7b839a]">
                Compatibilità completa con Soldi (CSV)
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

        <div className="space-y-4 pt-4 text-xs">
          {/* Quick Stats */}
          <div className="bg-[#f5f6fb] dark:bg-[#1e2236] p-3 rounded-2xl flex justify-between items-center text-[#5b6478] dark:text-[#aab2c8]">
            <span>Movimenti registrati:</span>
            <strong className="text-sm text-[#1c2030] dark:text-[#eef0f7]">
              {transactions.length}
            </strong>
          </div>

          {importStatus && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 rounded-xl flex items-center gap-2">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{importStatus}</span>
            </div>
          )}

          {/* Export CSV */}
          <div className="p-4 border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl space-y-2">
            <h4 className="font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-1.5">
              <Download className="w-4 h-4 text-[#5566ff]" />
              <span>Esporta Backup CSV</span>
            </h4>
            <p className="text-[#8a92a6] dark:text-[#7b839a]">
              Scarica tutti i movimenti in formato CSV compatibile con Excel e l&apos;app Soldi.
            </p>
            <button
              type="button"
              onClick={handleExport}
              className="w-full py-2 px-3 bg-[#eef0f7] dark:bg-[#1e2236] hover:bg-[#e2e5f0] text-[#1c2030] dark:text-[#eef0f7] font-semibold rounded-xl transition-colors cursor-pointer"
            >
              Scarica CSV
            </button>
          </div>

          {/* Import CSV */}
          <div className="p-4 border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl space-y-2">
            <h4 className="font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-1.5">
              <Upload className="w-4 h-4 text-[#12b886]" />
              <span>Importa file CSV</span>
            </h4>
            <p className="text-[#8a92a6] dark:text-[#7b839a]">
              Carica un backup CSV per aggiungere i tuoi movimenti alla dashboard.
            </p>
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2 px-3 bg-[#12b886]/10 text-[#12b886] hover:bg-[#12b886]/20 font-semibold rounded-xl transition-colors cursor-pointer"
            >
              Seleziona file CSV
            </button>
          </div>

          {/* Reset to Demo */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Vuoi ripristinare i dati demo di esempio?')) {
                  onResetDemo();
                  onClose();
                }
              }}
              className="w-full py-2 px-3 flex items-center justify-center gap-1.5 text-[#e8546b] hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-xl transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Ripristina dati demo iniziali</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
