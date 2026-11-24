export type ShadowAiSectionFlag = 'on' | 'off';

export const SHADOW_AI_SECTION: ShadowAiSectionFlag = 'on';

export function isShadowAiSectionEnabled(
  flag: ShadowAiSectionFlag = SHADOW_AI_SECTION
): boolean {
  return flag === 'on';
}
