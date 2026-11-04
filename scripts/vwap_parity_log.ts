/**
 * Log di parita' del VWAP di sessione su DATI REALI Yahoo Finance (5 minuti).
 *
 * Uso: npx tsx scripts/vwap_parity_log.ts <TICKER> <YYYY-MM-DD>
 * Esempio: npx tsx scripts/vwap_parity_log.ts AAPL 2026-11-03
 *
 * Stampa vwapCumulative alle 09:45, 10:00 e 11:00 ET della data richiesta, calcolata dalle barre
 * 5m reali del feed: nessun prezzo o volume di mercato e' scritto nel codice.
 * Se il feed non risponde (rate limit / rete) lo script esce con codice 1 e un messaggio esplicito.
 */
import { computeSessionVwap, VwapBar } from '../src/utils/calculator';
import { getMarketTime } from '../src/utils/timezone';

const CUTOFFS: { label: string; hour: number; minute: number }[] = [
  { label: '09:45', hour: 9, minute: 45 },
  { label: '10:00', hour: 10, minute: 0 },
  { label: '11:00', hour: 11, minute: 0 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Istante UTC corrispondente a un orario LOCALE di mercato (gestisce EST/EDT senza offset fissi)
function etTimeToMs(dateStr: string, hour: number, minute: number): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  for (const offsetHours of [5, 4]) {
    const ms = Date.UTC(y, mo - 1, d, hour + offsetHours, minute, 0);
    const mt = getMarketTime('US', new Date(ms));
    if (mt.dateFormatted === dateStr && mt.hour === hour && mt.minute === minute) return ms;
  }
  throw new Error(`Impossibile convertire ${dateStr} ${hour}:${String(minute).padStart(2, '0')} ET in UTC`);
}

async function fetchYahoo5m(ticker: string, dateStr: string): Promise<VwapBar[]> {
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Finestra: 00:00 ET del giorno prima -> 23:59 ET del giorno dopo (copre pre/post e fuso)
  const period1 = Math.floor(Date.UTC(y, mo - 1, d - 1, 0, 0, 0) / 1000);
  const period2 = Math.floor(Date.UTC(y, mo - 1, d + 1, 23, 59, 59) / 1000);
  const symbol = encodeURIComponent(ticker);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=5m&period1=${period1}&period2=${period2}&includePrePost=true`;

  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} ${resp.statusText}`;
        if (resp.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        break;
      }
      const json: any = await resp.json();
      const result = json?.chart?.result?.[0];
      const ts: number[] = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      if (ts.length === 0) {
        lastError = 'feed senza barre per la finestra richiesta';
        break;
      }
      return ts.map((t: number, i: number) => ({
        timestamp: t,
        high: q.high?.[i] ?? null,
        low: q.low?.[i] ?? null,
        close: q.close?.[i] ?? null,
        volume: q.volume?.[i] ?? null,
      }));
    } catch (err: any) {
      lastError = err?.message || String(err);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`Feed Yahoo non disponibile per ${ticker} ${dateStr}: ${lastError}`);
}

async function main() {
  const ticker = (process.argv[2] || '').trim().toUpperCase();
  const dateStr = (process.argv[3] || '').trim();

  if (!ticker || !DATE_RE.test(dateStr)) {
    console.error('Uso: npx tsx scripts/vwap_parity_log.ts <TICKER> <YYYY-MM-DD>');
    process.exit(1);
  }

  const bars = await fetchYahoo5m(ticker, dateStr);
  console.log(`VWAP di sessione (dati reali Yahoo 5m) - ${ticker} - ${dateStr}`);
  console.log('Formula: sum(((H+L+C)/3) * Volume) / sum(Volume), ancora 09:30 ET, after-market escluso\n');

  for (const cutoff of CUTOFFS) {
    const cutoffMs = etTimeToMs(dateStr, cutoff.hour, cutoff.minute);
    const cutoffSec = Math.floor(cutoffMs / 1000);
    // Solo barre chiuse prima del cutoff: il VWAP e' cumulativo fino a quell'istante
    const barsUpTo = bars.filter((b) => b.timestamp < cutoffSec);
    const nowMinutes = cutoff.hour * 60 + cutoff.minute;
    const res = computeSessionVwap(barsUpTo, 'US', dateStr, { nowMinutes });
    console.log(
      `${cutoff.label} ET | barre ${res.barsUsed} | volume ${res.cumulativeVolume.toLocaleString('en-US')} | ` +
        `vwapCumulative ${res.vwap != null ? res.vwap.toFixed(4) : 'n/a'} | ` +
        `coverage ${res.coverage != null ? res.coverage.toFixed(3) : 'n/a'}`
    );
  }
}

main().catch((err) => {
  console.error(`ERRORE: ${err?.message || String(err)}`);
  process.exit(1);
});
