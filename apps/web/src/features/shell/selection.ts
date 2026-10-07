import {
  DEFAULT_THEME_PRESET_ID,
  FONT_WEIGHTS,
  isBundledFontId,
  isThemePresetId,
  themePreset,
  type BundledFontId,
  type FontWeight,
  type ThemePreset,
} from '@louvorvisual/domain';

export type VisualSelection = {
  preset: ThemePreset;
  fontId: BundledFontId;
  /** A fonte veio de uma escolha manual, não do tema. */
  fontChosen: boolean;
  fontWeight: FontWeight;
};

/**
 * Lê tema, fonte e peso da query (`tema`, `fonte`, `peso`). Valores ausentes ou
 * desconhecidos caem no padrão; sem fonte escolhida, vale a inicial do tema.
 */
export function readVisualSelection(query: URLSearchParams): VisualSelection {
  const tema = query.get('tema') ?? '';
  const fonte = query.get('fonte') ?? '';
  const peso = Number(query.get('peso'));
  const preset = themePreset(isThemePresetId(tema) ? tema : DEFAULT_THEME_PRESET_ID);
  const fontChosen = isBundledFontId(fonte);
  return {
    preset,
    fontId: fontChosen ? fonte : preset.initialFontId,
    fontChosen,
    fontWeight: FONT_WEIGHTS.find((weight) => weight === peso) ?? preset.style.fontWeight,
  };
}

/** Texto original de demonstração, com os acentos usados em português. */
export const SAMPLE_SLIDE_TEXT = 'A luz chegou sobre a cidade\nCantamos juntos, gratidão';
