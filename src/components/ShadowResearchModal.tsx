import React, { useEffect, useState } from 'react';
import ShadowResearchPanel, { type ShadowPanelData } from './ShadowResearchPanel';

/**
 * Trigger + modale per ShadowResearchPanel (Passo M).
 *
 * Il pannello esisteva dal Passo L ma non era raggiungibile: qui si monta.
 * Legge `GET /api/shadow/latest` (sola lettura). Tre stati gestiti:
 * available true, available false, errore di rete. Se l'artefatto manca il
 * pannello resta raggiungibile e dice "nessun artefatto": l'assenza e'
 * informazione, non un motivo per nascondere la sezione.
 *
 * `data` / `error` sono iniettabili solo per i test (render statico, senza
 * effetti): in produzione il componente fa il fetch da solo.
 */
export const ShadowResearchModal: React.FC<{
  initialOpen?: boolean;
  data?: ShadowPanelData | null;
  error?: string | null;
}> = ({ initialOpen = false, data: dataProp, error: errorProp }) => {
  const [open, setOpen] = useState(initialOpen);
  const [fetched, setFetched] = useState<ShadowPanelData | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || dataProp !== undefined) return;
    let alive = true;
    setLoading(true);
    setNetError(null);
    fetch('/api/shadow/latest')
      .then(r => r.json())
      .then((d: ShadowPanelData) => {
        if (!alive) return;
        setFetched(d);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setNetError('errore di rete: impossibile leggere l’artefatto shadow');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, dataProp]);

  const data = dataProp !== undefined ? dataProp : fetched;
  const shownError = errorProp ?? netError;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        data-testid="shadow-research-trigger"
        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold cursor-pointer transition-colors"
      >
        Shadow Research
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/80 p-4 overflow-auto"
          role="dialog"
          aria-label="Shadow Research"
          data-testid="shadow-research-modal"
        >
          <div className="w-full max-w-4xl rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">Shadow Research</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-xs cursor-pointer"
              >
                Chiudi
              </button>
            </div>
            {loading && <p className="text-xs text-slate-400">caricamento…</p>}
            {shownError && (
              <p className="text-xs text-rose-300" data-testid="shadow-error">
                {shownError}
              </p>
            )}
            {!loading && !shownError && <ShadowResearchPanel data={data} />}
          </div>
        </div>
      )}
    </>
  );
};

export default ShadowResearchModal;
