import { describe, expect, it } from 'vitest';
import { themePreset, THEME_PRESETS } from './catalog';
import { applyThemeToArrangement, createThemeCopy, themeStyleOf } from './customTheme';
import { paletteIssues } from './theme';

const context = { workspaceId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', now: '2026-10-06T12:00:00.000Z', newId: () => '00000000-0000-4000-8000-000000000003' };

describe('tema personalizado', () => {
  it.each(THEME_PRESETS.map((preset) => [preset.presetId]))('a cópia de %s começa igual ao tema de fábrica e não o altera', (presetId) => {
    const preset = themePreset(presetId);
    const copy = createThemeCopy(preset, `  ${preset.name} (cópia) `, context);
    expect(copy.name).toBe(`${preset.name} (cópia)`);
    expect(copy.basePresetId).toBe(presetId);
    expect(copy.fontId).toBe(preset.initialFontId);
    expect(themeStyleOf(copy)).toEqual(preset.style);
    expect(paletteIssues(copy.palette)).toEqual([]);
    copy.palette.backgroundColor = '#FFFFFF';
    copy.margins.horizontalPercent = 20;
    expect(themePreset(presetId).style.palette.backgroundColor).not.toBe('#FFFFFF');
    expect(themePreset(presetId).style.margins.horizontalPercent).toBe(8);
  });

  it('aplicar sem alterações não deixa ajuste nenhum no arranjo', () => {
    const copy = createThemeCopy(themePreset('violeta'), 'Violeta (cópia)', context);
    expect(applyThemeToArrangement(copy, { fontId: null })).toEqual({ themeRef: { kind: 'builtin', presetId: 'violeta' }, themeOverrides: null, fontId: null });
  });

  it('aplicar leva só as diferenças: fundo e letra juntos, margens e sombra', () => {
    const copy = { ...createThemeCopy(themePreset('grafite'), 'Culto da noite', context), palette: { backgroundColor: '#101010', textColor: '#FFE9A8' }, margins: { horizontalPercent: 12, verticalPercent: 6 }, shadow: 'soft' as const, fontId: 'lato' };
    expect(applyThemeToArrangement(copy, { fontId: null })).toEqual({
      themeRef: { kind: 'builtin', presetId: 'grafite' },
      themeOverrides: { palette: { backgroundColor: '#101010', textColor: '#FFE9A8' }, margins: { horizontalPercent: 12, verticalPercent: 6 }, shadow: 'soft' },
      fontId: 'lato',
    });
  });

  it('a fonte escolhida à mão no arranjo permanece', () => {
    const copy = { ...createThemeCopy(themePreset('grafite'), 'Culto da noite', context), fontId: 'lato' };
    expect(applyThemeToArrangement(copy, { fontId: 'montserrat' }).fontId).toBe('montserrat');
  });

  it('base desconhecida cai no tema de segurança, com a aparência do tema preservada', () => {
    const copy = { ...createThemeCopy(themePreset('ambar'), 'Antigo', context), basePresetId: 'tema-que-nao-existe-mais' };
    const applied = applyThemeToArrangement(copy, { fontId: null });
    expect(applied.themeRef).toEqual({ kind: 'builtin', presetId: 'preto-acessivel' });
    expect(applied.themeOverrides?.palette).toEqual(themePreset('ambar').style.palette);
    expect(applied.fontId).toBe('source-sans-3');
  });
});
