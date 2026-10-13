import React, { useState } from 'react';
import {
  X,
  Mail,
  Send,
  Sparkles,
  Bot,
  Code2,
  Check,
  Copy,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  Cpu,
} from 'lucide-react';

interface CreatorContactModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreatorContactModal: React.FC<CreatorContactModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [name, setName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [topic, setTopic] = useState('Sviluppo App con Vibe Coding / AI');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  if (!isOpen) return null;

  const targetEmail = 'christian.battistoni.eu@gmail.com';

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(targetEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const subject = encodeURIComponent(`[Contatto Portfolio/Demo] ${topic} - ${name || 'Nuovo Messaggio'}`);
    const bodyContent = `Ciao Christian,\n\nSono: ${name || 'Non specificato'}\nEmail: ${senderEmail || 'Non specificata'}\nArgomento: ${topic}\n\nMessaggio:\n${message}\n\n---\nInviato da Intraday Radar Demo App`;
    const mailtoUrl = `mailto:${targetEmail}?subject=${subject}&body=${encodeURIComponent(bodyContent)}`;

    window.location.href = mailtoUrl;
    setSubmitted(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-emerald-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base md:text-lg font-bold text-white flex items-center gap-2">
                Christian Battistoni
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Creator & Developer
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                AI Orchestrator • AI Prompt Engineer • Vibe Coding Specialist
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Creator Profile Overview */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4.5 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                Specializzazione & Competenze
              </span>
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2 py-0.5 rounded-full font-mono">
                <ShieldCheck className="w-3 h-3" />
                Vibe Coding & Next-Gen AI
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Progetto e sviluppo applicazioni web moderne ad alta intensità tecnologica combinando le tecniche più avanzate di <strong>Vibe Coding</strong> con competenze professionali di <strong>AI Orchestration</strong> e <strong>AI Prompt Engineering</strong>. Questa applicazione traduce complessi modelli quantitativi, flussi di dati d'exchange in tempo reale e ragionamento euristico guidato da LLM in un'esperienza utente reattiva, solida e scalabile.
            </p>

            {/* Skill Tags */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                'Vibe Coding Full-Stack',
                'AI Orchestrator',
                'AI Prompt Engineer',
                'LLM & Gemini Reasoning',
                'TypeScript & React',
                'Quantitative Finance Logic',
                'Real-Time Market APIs',
                'PWA Architecture',
              ].map((skill) => (
                <span
                  key={skill}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800 text-slate-300 font-mono"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>

          {/* Mandatory Legal & Demo Disclaimer */}
          <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/40 text-amber-200/90 text-xs flex gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-300 text-xs">
                Avviso Legale & Natura Dimostrativa (DEMO):
              </p>
              <p className="text-[11px] leading-relaxed text-amber-200/80">
                Christian Battistoni <strong>non effettua alcun tipo di consulenza finanziaria</strong>, gestione patrimoniale né sollecitazione al pubblico risparmio. Questa applicazione è <strong>esclusivamente un progetto dimostrativo / demo</strong> a scopo tecnologico, educativo e di portfolio software per illustrare le potenzialità del Vibe Coding e dell'AI Orchestration. Nessun contenuto costituisce un invito a investire.
              </p>
            </div>
          </div>

          {/* Direct Email Quick Action */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Mail className="w-4 h-4 text-sky-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] text-slate-400 uppercase tracking-wider font-mono">Email Diretta</p>
                <p className="text-xs md:text-sm font-mono text-slate-200 font-semibold truncate">
                  {targetEmail}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCopyEmail}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs transition-colors shrink-0 font-medium cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copiato!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copia Email</span>
                </>
              )}
            </button>
          </div>

          {/* Contact Form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5 text-sky-400" />
                Invia un Messaggio o Proposta di Collaborazione
              </h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  Il tuo Nome o Azienda
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Es. Mario Rossi / Tech Corp"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  La tua Email di Contatto
                </label>
                <input
                  type="email"
                  value={senderEmail}
                  onChange={(e) => setSenderEmail(e.target.value)}
                  placeholder="nome@dominio.com"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                Oggetto / Argomento della Richiesta
              </label>
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="Sviluppo App con Vibe Coding / AI">
                  Sviluppo Nuova Applicazione con Vibe Coding
                </option>
                <option value="Consulenza AI Orchestration & Prompt Engineering">
                  AI Orchestration & Prompt Engineering
                </option>
                <option value="Proposta di Collaborazione / Lavoro">
                  Proposta di Collaborazione Professionale
                </option>
                <option value="Feedback Tecnico sulla Demo Intraday Radar">
                  Feedback Tecnico sulla Demo
                </option>
                <option value="Altro">Altra richiesta</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                Messaggio
              </label>
              <textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Descrivi brevemente il tuo progetto, idea o richiesta..."
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-sky-600 hover:from-indigo-500 hover:to-sky-500 text-white font-medium text-xs shadow-lg shadow-indigo-900/30 transition-all cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Invia Messaggio (Apre il tuo Client Email)</span>
            </button>
          </form>

          {submitted && (
            <div className="p-3 bg-emerald-950/40 border border-emerald-800/40 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                Il tuo client email è stato aperto con il messaggio precompilato. In caso contrario, puoi scrivere liberamente a <strong>{targetEmail}</strong>.
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono text-[11px]">
            Portfolio & Vibe Coding Tech Demo
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
