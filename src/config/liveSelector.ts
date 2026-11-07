/**
 * Selezione modalità live per il setup selector.
 * Il flag live viene passato a rankMarketCandidates/buildExecutionSetup solo
 * quando SETUP_SELECTOR_LIVE === 'on'; in modalità "off" il comportamento
 * è identico alla baseline main (a718bfd).
 */
export const SETUP_SELECTOR_LIVE_FLAG = (() => {
  if (typeof process === 'undefined') return 'off';
  return (process.env.SETUP_SELECTOR_LIVE ?? 'off') as 'on' | 'off';
})();

export function isLiveMode(): boolean {
  return SETUP_SELECTOR_LIVE_FLAG === 'on';
}

export function liveModeFlag(): 'on' | 'off' {
  return SETUP_SELECTOR_LIVE_FLAG;
}
