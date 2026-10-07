import type { FontWeight, ThemePalette, ThemeStyle } from './theme';

/** Versão do pacote de fontes embutido; muda quando qualquer arquivo muda. */
export const FONT_PACK_VERSION = '1';

export const BUNDLED_FONT_IDS = [
  'inter',
  'roboto',
  'open-sans',
  'montserrat',
  'lato',
  'noto-sans',
  'source-sans-3',
  'atkinson-hyperlegible',
] as const;
export type BundledFontId = (typeof BUNDLED_FONT_IDS)[number];

export type BundledFont = {
  fontId: BundledFontId;
  family: string;
};

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { fontId: 'inter', family: 'Inter' },
  { fontId: 'roboto', family: 'Roboto' },
  { fontId: 'open-sans', family: 'Open Sans' },
  { fontId: 'montserrat', family: 'Montserrat' },
  { fontId: 'lato', family: 'Lato' },
  { fontId: 'noto-sans', family: 'Noto Sans' },
  { fontId: 'source-sans-3', family: 'Source Sans 3' },
  { fontId: 'atkinson-hyperlegible', family: 'Atkinson Hyperlegible' },
];

/** Fonte de recuperação explícita quando um arquivo do pacote falha. */
export const RECOVERY_FONT_ID: BundledFontId = 'inter';
export const SYSTEM_FALLBACK_STACK = 'system-ui, sans-serif';

export function isBundledFontId(value: string): value is BundledFontId {
  return (BUNDLED_FONT_IDS as readonly string[]).includes(value);
}

export function bundledFont(fontId: BundledFontId): BundledFont {
  // BUNDLED_FONTS cobre todos os IDs; ver catalog.test.ts.
  return BUNDLED_FONTS.find((font) => font.fontId === fontId) as BundledFont;
}

/** Arquivo de uma família em um peso real, identificado pelo hash dos bytes. */
export type FontFaceFile = {
  weight: FontWeight;
  style: 'normal';
  file: string;
  sha256: string;
  byteSize: number;
};

export type FontPackEntry = {
  fontId: BundledFontId;
  family: string;
  license: string;
  licenseFile: string;
  licenseSha256: string;
  /** Nome reservado declarado na licença, quando existe. */
  reservedFontName: string | null;
  source: {
    package: string;
    packageVersion: string;
    upstreamVersion: string;
    metadataUrl: string;
  };
  subsets: string[];
  unicodeRange: string;
  faces: FontFaceFile[];
};

/** Lista completa dos arquivos do pacote; caminhos relativos à pasta do manifesto. */
export type FontPackManifest = {
  version: string;
  fonts: FontPackEntry[];
};

export const THEME_PRESET_IDS = [
  'grafite',
  'azul-noturno',
  'violeta',
  'verde-profundo',
  'vinho',
  'ambar',
  'petroleo',
  'preto-acessivel',
] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

/** Tema de fábrica: entregue com o aplicativo, nunca recebido do servidor. */
export type ThemePreset = {
  presetId: ThemePresetId;
  name: string;
  version: number;
  initialFontId: BundledFontId;
  style: ThemeStyle;
};

export const DEFAULT_THEME_PRESET_ID: ThemePresetId = 'grafite';
/** Usado quando a configuração escolhida está indisponível. */
export const SAFETY_THEME_PRESET_ID: ThemePresetId = 'preto-acessivel';

function preset(
  presetId: ThemePresetId,
  name: string,
  palette: ThemePalette,
  initialFontId: BundledFontId,
  fontSizePx = 96,
): ThemePreset {
  return {
    presetId,
    name,
    version: 1,
    initialFontId,
    style: {
      aspectRatio: '16:9',
      palette,
      fontSizePx,
      fontWeight: 700,
      textAlign: 'center',
      verticalAlign: 'center',
      lineHeight: 1.2,
      margins: { horizontalPercent: 8, verticalPercent: 8 },
      shadow: 'none',
      outline: null,
      transition: { kind: 'fade', durationMs: 150 },
      credits: { showTitle: false, showArtist: false },
    },
  };
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  preset('grafite', 'Grafite', { backgroundColor: '#111827', textColor: '#F9FAFB' }, 'inter'),
  preset('azul-noturno', 'Azul noturno', { backgroundColor: '#0B1730', textColor: '#DBEAFE' }, 'roboto'),
  preset('violeta', 'Violeta', { backgroundColor: '#1B1033', textColor: '#EDE9FE' }, 'montserrat'),
  preset('verde-profundo', 'Verde profundo', { backgroundColor: '#0B2119', textColor: '#D1FAE5' }, 'lato'),
  preset('vinho', 'Vinho', { backgroundColor: '#2A0E18', textColor: '#FFE4E6' }, 'open-sans'),
  preset('ambar', 'Âmbar', { backgroundColor: '#211809', textColor: '#FDE68A' }, 'source-sans-3'),
  preset('petroleo', 'Petróleo', { backgroundColor: '#08242A', textColor: '#CCFBF1' }, 'noto-sans'),
  // Tema de segurança: letras maiores, portanto menos linhas por slide.
  preset('preto-acessivel', 'Preto acessível', { backgroundColor: '#000000', textColor: '#FFFFFF' }, 'atkinson-hyperlegible', 120),
];

export function isThemePresetId(value: string): value is ThemePresetId {
  return (THEME_PRESET_IDS as readonly string[]).includes(value);
}

export function themePreset(presetId: ThemePresetId): ThemePreset {
  return THEME_PRESETS.find((item) => item.presetId === presetId) as ThemePreset;
}
