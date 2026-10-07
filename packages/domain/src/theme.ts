import { contrastRatio, isHexColor, MAX_BACKGROUND_LUMINANCE, MIN_CONTRAST_RATIO, relativeLuminance } from './color';
import type { AggregateMeta, Uuid } from './common';

/** Tema embutido no aplicativo ou cópia personalizada da equipe. */
export type ThemeRef = { kind: 'builtin'; presetId: string } | { kind: 'workspace'; themeId: Uuid };

/** Fundo sólido escuro e cor das letras; herdados sempre como uma unidade. */
export type ThemePalette = {
  backgroundColor: string;
  textColor: string;
};

export const ASPECT_RATIOS = ['16:9', '4:3'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Pesos com arquivos reais no pacote de fontes; sem negrito sintetizado. */
export const FONT_WEIGHTS = [400, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const VERTICAL_ALIGNS = ['top', 'center', 'bottom'] as const;
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];

export const SHADOWS = ['none', 'soft', 'strong'] as const;
export type Shadow = (typeof SHADOWS)[number];

export const TRANSITION_KINDS = ['cut', 'fade'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** Limites na composição de referência (1920×1080 em 16:9). */
export const FONT_SIZE_PX = { min: 32, max: 160, step: 4 } as const;
export const LINE_HEIGHT = { min: 0.9, max: 2 } as const;
export const MARGIN_PERCENT = { min: 0, max: 25 } as const;
export const OUTLINE_WIDTH_PX = { min: 1, max: 8 } as const;
export const TRANSITION_DURATION_MS = { min: 0, max: 1000, default: 150 } as const;

export type ThemeOutline = { color: string; widthPx: number };
export type ThemeMargins = { horizontalPercent: number; verticalPercent: number };
export type ThemeTransition = { kind: TransitionKind; durationMs: number };
export type ThemeCredits = { showTitle: boolean; showArtist: boolean };

/** Configuração visual resolvível de um tema, sem a referência de fonte. */
export type ThemeStyle = {
  aspectRatio: AspectRatio;
  palette: ThemePalette;
  fontSizePx: number;
  fontWeight: FontWeight;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  lineHeight: number;
  margins: ThemeMargins;
  shadow: Shadow;
  outline: ThemeOutline | null;
  transition: ThemeTransition;
  credits: ThemeCredits;
};

/** Ajustes do arranjo sobre o tema referenciado. */
export type ThemeOverrides = Partial<ThemeStyle>;

/** Tema personalizado do espaço; temas de fábrica são catálogo do aplicativo. */
export type Theme = AggregateMeta &
  ThemeStyle & {
    id: Uuid;
    name: string;
    basePresetId: string | null;
    fontId: string;
    fontPackVersion: string;
  };

export type PaletteIssue = 'invalid-color' | 'background-not-dark' | 'low-contrast';

export function paletteIssues(palette: ThemePalette): PaletteIssue[] {
  if (!isHexColor(palette.backgroundColor) || !isHexColor(palette.textColor)) return ['invalid-color'];
  const issues: PaletteIssue[] = [];
  if (relativeLuminance(palette.backgroundColor) > MAX_BACKGROUND_LUMINANCE) issues.push('background-not-dark');
  if (contrastRatio(palette.backgroundColor, palette.textColor) < MIN_CONTRAST_RATIO) issues.push('low-contrast');
  return issues;
}
