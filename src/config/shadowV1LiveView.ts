/**
 * Flag della vista V1-live nel pannello shadow (PR D2).
 *
 * Convenzione `src/config/*.ts` come `stalenessFlag.ts` e `liveSelector.ts`:
 * costante tipizzata, default `'off'`. La vista si attiva solo con `'on'` e
 * resta indipendente dai flag di raccolta e di endpoint.
 */
export type ShadowV1LiveViewPanelFlag = 'on' | 'off';

export const SHADOW_V1_LIVE_VIEW_PANEL: ShadowV1LiveViewPanelFlag = 'off';

export function isShadowV1LivePanelEnabled(
  flag: ShadowV1LiveViewPanelFlag = SHADOW_V1_LIVE_VIEW_PANEL
): boolean {
  return flag === 'on';
}
