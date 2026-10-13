import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  Download,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Plus,
} from 'lucide-react';
import { UnderlyingItem } from '../types/radar';
import {
  parseUnderlyingsCsv,
  exportUnderlyingsToCsv,
  DEFAULT_TRADE_REPUBLIC_UNDERLYINGS,
} from '../data/defaultUnderlyings';

interface CsvManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  underlyings: UnderlyingItem[];
  onUpdateUnderlyings: (items: UnderlyingItem[]) => void;
}

export const CsvManagerModal: React.FC<CsvManagerModalProps> = ({
  isOpen,
  onClose,
  underlyings,
  onUpdateUnderlyings,
}) => {
  const [filterMarket, setFilterMarket] = useState<'ALL' | 'EU' | 'US'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // Manual Add Form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newNome, setNewNome] = useState('');
  const [newMercato, setNewMercato] = useState<'EU' | 'US'>('EU');
  const [newValuta, setNewValuta] = useState('EUR');

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportErrors([]);
    setImportSuccess(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const { items, errors } = parseUnderlyingsCsv(text);
      if (items.length > 0) {
        onUpdateUnderlyings(items);
        setImportSuccess(`Caricati con successo ${items.length} sottostanti da CSV.`);
      }
      if (errors.length > 0) {
        setImportErrors(errors);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDownloadCsv = () => {
    const csvContent = exportUnderlyingsToCsv(underlyings);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'sottostanti_trade_republic_ko.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleResetDefault = () => {
    if (
      window.confirm(
        'Ripristinare l’elenco predefinito dei sottostanti Knock-Out Trade Republic (Europa + USA)?'
      )
    ) {
      onUpdateUnderlyings(DEFAULT_TRADE_REPUBLIC_UNDERLYINGS);
      setImportSuccess('Elenco sottostanti ripristinato ai valori predefiniti di Trade Republic.');
      setImportErrors([]);
    }
  };

  const handleDeleteItem = (ticker: string) => {
    const updated = underlyings.filter((item) => item.ticker !== ticker);
    onUpdateUnderlyings(updated);
  };

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTicker.trim() || !newNome.trim()) return;

    const exists = underlyings.some((u) => u.ticker.toUpperCase() === newTicker.trim().toUpperCase());
    if (exists) {
      setImportErrors([`Il ticker ${newTicker} è già presente nell'elenco.`]);
      return;
    }

    const newItem: UnderlyingItem = {
      ticker: newTicker.trim().toUpperCase(),
      nome: newNome.trim(),
      mercato: newMercato,
      valuta: newValuta.trim().toUpperCase(),
    };

    onUpdateUnderlyings([...underlyings, newItem]);
    setNewTicker('');
    setNewNome('');
    setShowAddForm(false);
  };

  const filteredItems = underlyings.filter((item) => {
    const matchesMarket = filterMarket === 'ALL' || item.mercato === filterMarket;
    const matchesSearch =
      item.ticker.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.nome.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesMarket && matchesSearch;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950">
          <div>
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              Gestione Sottostanti Trade Republic KO
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                {underlyings.length} attivi
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Regola ferrea: l'app esegue lo screening <strong>esclusivamente</strong> sui titoli presenti in questo elenco.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Bar */}
        <div className="p-6 border-b border-slate-800/80 bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".csv"
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-sm"
            >
              <Upload className="w-4 h-4" />
              <span>Carica CSV</span>
            </button>

            <button
              onClick={handleDownloadCsv}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
            >
              <Download className="w-4 h-4" />
              <span>Scarica CSV</span>
            </button>

            <button
              onClick={handleResetDefault}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Predefiniti TR</span>
            </button>

            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              <span>Aggiungi Singolo</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Mercato:</span>
            <div className="flex rounded-lg bg-slate-950 p-0.5 border border-slate-800 text-xs">
              <button
                onClick={() => setFilterMarket('ALL')}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  filterMarket === 'ALL' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setFilterMarket('EU')}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  filterMarket === 'EU' ? 'bg-slate-800 text-emerald-400 font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Europa
              </button>
              <button
                onClick={() => setFilterMarket('US')}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  filterMarket === 'US' ? 'bg-slate-800 text-sky-400 font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                USA
              </button>
            </div>
          </div>
        </div>

        {/* Notifications */}
        {importSuccess && (
          <div className="mx-6 mt-4 p-3 rounded-lg bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{importSuccess}</span>
          </div>
        )}

        {importErrors.length > 0 && (
          <div className="mx-6 mt-4 p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs">
            <div className="flex items-center gap-2 font-medium mb-1">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              <span>Avvisi di importazione:</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-rose-300/90 text-[11px]">
              {importErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Manual Add Form Drawer */}
        {showAddForm && (
          <form
            onSubmit={handleManualAdd}
            className="mx-6 mt-4 p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-wrap items-center gap-3 text-xs"
          >
            <div className="flex-1 min-w-[120px]">
              <label className="block text-[11px] text-slate-400 mb-1">Ticker (es. RACE.MI o AAPL)</label>
              <input
                type="text"
                required
                placeholder="Ticker"
                value={newTicker}
                onChange={(e) => setNewTicker(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white uppercase font-mono"
              />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-[11px] text-slate-400 mb-1">Nome Società</label>
              <input
                type="text"
                required
                placeholder="Nome"
                value={newNome}
                onChange={(e) => setNewNome(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-white"
              />
            </div>
            <div className="w-24">
              <label className="block text-[11px] text-slate-400 mb-1">Mercato</label>
              <select
                value={newMercato}
                onChange={(e) => {
                  const m = e.target.value as 'EU' | 'US';
                  setNewMercato(m);
                  setNewValuta(m === 'EU' ? 'EUR' : 'USD');
                }}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white"
              >
                <option value="EU">Europa</option>
                <option value="US">USA</option>
              </select>
            </div>
            <div className="w-20">
              <label className="block text-[11px] text-slate-400 mb-1">Valuta</label>
              <input
                type="text"
                value={newValuta}
                onChange={(e) => setNewValuta(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-white uppercase font-mono"
              />
            </div>
            <div className="flex items-center gap-2 self-end">
              <button
                type="submit"
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md font-medium"
              >
                Salva
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-3 py-1.5 bg-slate-800 text-slate-400 hover:text-white rounded-md"
              >
                Annulla
              </button>
            </div>
          </form>
        )}

        {/* Search */}
        <div className="px-6 pt-4 pb-2">
          <input
            type="text"
            placeholder="Cerca per ticker o nome società..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-700"
          />
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          <table className="w-full text-xs text-left">
            <thead className="text-[11px] uppercase tracking-wider text-slate-400 bg-slate-950/60 sticky top-0 border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3">Ticker</th>
                <th className="py-2.5 px-3">Nome Sottostante</th>
                <th className="py-2.5 px-3">Mercato</th>
                <th className="py-2.5 px-3">Valuta</th>
                <th className="py-2.5 px-3 text-right">Azione</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredItems.map((item) => (
                <tr key={item.ticker} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-2 px-3 font-mono font-medium text-white">{item.ticker}</td>
                  <td className="py-2 px-3 text-slate-300">{item.nome}</td>
                  <td className="py-2 px-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                        item.mercato === 'EU'
                          ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                          : 'bg-sky-950/40 text-sky-300 border-sky-800/60'
                      }`}
                    >
                      {item.mercato === 'EU' ? 'Europa' : 'USA'}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-mono text-slate-400">{item.valuta}</td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => handleDeleteItem(item.ticker)}
                      className="p-1 hover:bg-rose-950/60 hover:text-rose-400 text-slate-500 rounded transition-colors"
                      title="Elimina sottostante"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Nessun sottostante trovato con i filtri correnti.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span>Formato CSV: ticker, nome, mercato, valuta</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
