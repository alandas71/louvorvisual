import type { Arrangement } from './arrangement';
import { FONT_PACK_VERSION, isThemePresetId, SAFETY_THEME_PRESET_ID, themePreset, type ThemePreset } from './catalog';
import { SCHEMA_VERSION, type IsoInstant, type Uuid } from './common';
import type { Theme, ThemeOverrides, ThemeStyle } from './theme';

type ThemeContext = { workspaceId: Uuid; userId: Uuid; now: IsoInstant; newId: () => Uuid };

const STYLE_KEYS = ['aspectRatio', 'palette', 'fontSizePx', 'fontWeight', 'textAlign', 'verticalAlign', 'lineHeight', 'margins', 'shadow', 'outline', 'transition', 'credits'] as const satisfies readonly (keyof ThemeStyle)[];

// Os valores de estilo são dados simples (JSON): cópia e comparação por serialização bastam.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Só a aparência do tema personalizado, sem nome, fonte e campos de revisão. */
export function themeStyleOf(theme: Theme): ThemeStyle {
  return Object.fromEntries(STYLE_KEYS.map((key) => [key, theme[key]])) as ThemeStyle;
}

/**
 * Cópia editável de um tema de fábrica. O tema de fábrica nunca muda; a
 * personalização vive nesta cópia, que pertence ao espaço de trabalho.
 */
export function createThemeCopy(preset: ThemePreset, name: string, context: ThemeContext): Theme {
  return {
    workspaceId: context.workspaceId,
    schemaVersion: SCHEMA_VERSION,
    serverRevision: null,
    createdBy: context.userId,
    updatedBy: context.userId,
    createdAt: context.now,
    updatedAt: context.now,
    deletedAt: null,
    id: context.newId(),
    name: name.trim(),
    basePresetId: preset.presetId,
    fontId: preset.initialFontId,
    fontPackVersion: FONT_PACK_VERSION,
    ...clone(preset.style),
  };
}


/**
 * O que gravar no arranjo para ele usar um tema personalizado. O arranjo fica
 * com uma cópia: tema de fábrica de base mais as diferenças. Assim ele abre em
 * qualquer dispositivo, inclusive onde o tema personalizado não existe ou foi
 * excluído, e alterar o tema depois não muda louvores já preparados.
 * A fonte escolhida à mão no arranjo permanece; sem ela, vale a do tema.
 */
export function applyThemeToArrangement(theme: Theme, arrangement: Pick<Arrangement, 'fontId'>): Pick<Arrangement, 'themeRef' | 'themeOverrides' | 'fontId'> {
  const base = themePreset(theme.basePresetId !== null && isThemePresetId(theme.basePresetId) ? theme.basePresetId : SAFETY_THEME_PRESET_ID);
  const style = themeStyleOf(theme);
  const overrides: ThemeOverrides = {};
  for (const key of STYLE_KEYS) {
    if (!same(style[key], base.style[key])) Object.assign(overrides, { [key]: clone(style[key]) });
  }
  return {
    themeRef: { kind: 'builtin', presetId: base.presetId },
    themeOverrides: Object.keys(overrides).length > 0 ? overrides : null,
    fontId: arrangement.fontId ?? (theme.fontId === base.initialFontId ? null : theme.fontId),
  };
}
