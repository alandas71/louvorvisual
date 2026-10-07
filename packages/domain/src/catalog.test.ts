import { describe, expect, it } from 'vitest';
import {
  BUNDLED_FONT_IDS,
  BUNDLED_FONTS,
  bundledFont,
  DEFAULT_THEME_PRESET_ID,
  SAFETY_THEME_PRESET_ID,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  themePreset,
} from './catalog';
import { FONT_SIZE_PX, paletteIssues } from './theme';

describe('catálogo de fontes', () => {
  it('tem oito famílias, uma por ID', () => {
    expect(BUNDLED_FONTS.map((font) => font.fontId)).toEqual([...BUNDLED_FONT_IDS]);
    expect(new Set(BUNDLED_FONTS.map((font) => font.family)).size).toBe(8);
    for (const fontId of BUNDLED_FONT_IDS) expect(bundledFont(fontId).fontId).toBe(fontId);
  });
});

describe('temas de fábrica', () => {
  it('tem oito temas, um por ID', () => {
    expect(THEME_PRESETS.map((item) => item.presetId)).toEqual([...THEME_PRESET_IDS]);
    for (const presetId of THEME_PRESET_IDS) expect(themePreset(presetId).presetId).toBe(presetId);
  });

  it.each(THEME_PRESETS.map((item) => [item.presetId, item] as const))('%s tem fundo escuro, contraste e tamanho válidos', (_id, item) => {
    expect(paletteIssues(item.style.palette)).toEqual([]);
    expect(item.style.fontSizePx).toBeGreaterThanOrEqual(FONT_SIZE_PX.min);
    expect(item.style.fontSizePx).toBeLessThanOrEqual(FONT_SIZE_PX.max);
    expect((item.style.fontSizePx - FONT_SIZE_PX.min) % FONT_SIZE_PX.step).toBe(0);
  });

  it('cada tema começa com uma fonte diferente do pacote', () => {
    expect(new Set(THEME_PRESETS.map((item) => item.initialFontId))).toEqual(new Set(BUNDLED_FONT_IDS));
  });

  it('paletas são distintas', () => {
    expect(new Set(THEME_PRESETS.map((item) => item.style.palette.backgroundColor)).size).toBe(8);
  });

  it('Grafite é o inicial e Preto acessível, o de segurança, tem letras maiores', () => {
    expect(DEFAULT_THEME_PRESET_ID).toBe('grafite');
    expect(themePreset(SAFETY_THEME_PRESET_ID).style.fontSizePx).toBeGreaterThan(themePreset('grafite').style.fontSizePx);
  });
});
