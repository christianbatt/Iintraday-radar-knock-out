import React, { useState, useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, Download, X, CheckCircle2, Smartphone, ShieldCheck } from 'lucide-react';

interface PwaPromptProps {
  onInstallReady?: (ready: boolean, triggerPrompt: () => void) => void;
}

export function PwaUpdatePrompt({ onInstallReady }: PwaPromptProps) {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isIosPromptOpen, setIsIosPromptOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      if (r) {
        // Periodically check for service worker updates (e.g. every 60 minutes)
        setInterval(() => {
          r.update().catch(() => {});
        }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.warn('PWA Service Worker registration error:', error);
    },
  });

  // Handle native install prompt
  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      if (onInstallReady) {
        onInstallReady(true, () => {
          (e as any).prompt();
          (e as any).userChoice.then((choiceResult: { outcome: string }) => {
            if (choiceResult.outcome === 'accepted') {
              setDeferredPrompt(null);
            }
          });
        });
      }
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, [onInstallReady]);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choiceResult = await deferredPrompt.userChoice;
      if (choiceResult.outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    } else {
      // Check if iOS
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      if (isIos) {
        setIsIosPromptOpen(true);
      }
    }
  };

  return (
    <>
      {/* 1. Update Available Banner */}
      {needRefresh && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md w-full bg-slate-900/95 backdrop-blur-md border border-emerald-500/50 shadow-2xl shadow-emerald-950/50 rounded-2xl p-4 text-slate-100 flex items-center justify-between gap-4 animate-in slide-in-from-bottom duration-300">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
            <div>
              <div className="font-semibold text-sm text-emerald-300 flex items-center gap-1.5">
                <span>Aggiornamento Immediato</span>
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">PWA</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Una nuova versione del terminale è pronta. Aggiorna senza riscaricare l'app!
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => updateServiceWorker(true)}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold rounded-lg shadow-sm transition-all active:scale-95 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Aggiorna</span>
            </button>
            <button
              onClick={() => setNeedRefresh(false)}
              className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              title="Chiudi"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 2. Offline Ready subtle notice */}
      {offlineReady && !isDismissed && (
        <div className="fixed bottom-5 left-5 z-40 max-w-sm bg-slate-900/90 backdrop-blur border border-slate-800 rounded-xl p-3 text-slate-300 text-xs flex items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Terminale pronto per il funzionamento PWA offline.</span>
          </div>
          <button
            onClick={() => {
              setOfflineReady(false);
              setIsDismissed(true);
            }}
            className="text-slate-500 hover:text-slate-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3. iOS Add to Home Screen Modal */}
      {isIosPromptOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-5 text-slate-200 shadow-2xl relative">
            <button
              onClick={() => setIsIosPromptOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-200"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-slate-100">Installa su iPhone / iPad</h3>
                <p className="text-xs text-slate-400">Aggiungi l'app alla schermata Home</p>
              </div>
            </div>
            <ol className="text-xs text-slate-300 space-y-2.5 list-decimal list-inside bg-slate-950/50 p-3 rounded-xl border border-slate-800/80">
              <li>Tocca il pulsante <span className="font-semibold text-sky-400">Condividi</span> nella barra inferiore di Safari.</li>
              <li>Scorri le opzioni e seleziona <span className="font-semibold text-sky-400">Aggiungi alla schermata Home</span>.</li>
              <li>Conferma toccando <span className="font-semibold text-emerald-400">Aggiungi</span> in alto a destra.</li>
            </ol>
            <button
              onClick={() => setIsIosPromptOpen(false)}
              className="mt-4 w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg transition-colors"
            >
              Ho capito
            </button>
          </div>
        </div>
      )}
    </>
  );
}
