import type { TradeJournalEntry } from '../types/radar';

/**
 * Merge deterministico di trade locali e cloud che rispetta i tombstone.
 *
 * IPOTESI: retention dei tombstone illimitata — ogni ID eliminato resta escluso
 * finche' non viene rimosso esplicitamente (nessun limite temporale introdotto).
 */
export function mergeTradesWithTombstones(
  local: readonly TradeJournalEntry[],
  cloud: readonly TradeJournalEntry[],
  tombstones: readonly string[],
): TradeJournalEntry[] {
  const blocked = new Set(tombstones);
  const tradeMap = new Map<string, TradeJournalEntry>();
  local.forEach((trade) => {
    if (!blocked.has(trade.id)) tradeMap.set(trade.id, trade);
  });
  cloud.forEach((trade) => {
    if (!blocked.has(trade.id)) tradeMap.set(trade.id, trade);
  });
  return Array.from(tradeMap.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}
