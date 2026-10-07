import { describe, expect, it } from 'vitest';
import { applyDuration, applyText, applyVisual, emptyOverrides } from './overrides';
import { mergeOverridesIntoArrangement } from './saveToArrangement';
import { timedSong } from './testing';

describe('salvar ajustes no arranjo', () => {
  it('leva só os campos ajustados, cada um para o seu lugar', () => {
    const { arrangement } = timedSong([8000, null, 12_000]);
    const [a, b] = arrangement.occurrences.map((item) => item.id) as [string, string, string];
    let state = applyVisual(emptyOverrides(), 'song', a, { themePresetId: 'violeta', fontId: 'lato', fontSizePx: 80 });
    state = applyVisual(state, 'occurrence', a, { fontSizePx: 120, themePresetId: 'ambar' });
    state = applyText(state, a, 'Texto revisado');
    state = applyDuration(state, b, 5000)!;
    state = applyDuration(state, a, null)!;

    const result = mergeOverridesIntoArrangement(arrangement, state.current, arrangement);
    expect(result).toMatchObject({ changed: true, conflicts: [], skipped: [] });
    expect(result.arrangement).toMatchObject({ themeRef: { kind: 'builtin', presetId: 'violeta' }, fontId: 'lato', themeOverrides: { fontSizePx: 80 } });
    expect(result.arrangement.occurrences[0]).toMatchObject({
      text: 'Texto revisado',
      durationMs: null,
      visualOverrides: { fontSizePx: 120, palette: { backgroundColor: '#211809', textColor: '#FDE68A' } },
    });
    expect(result.arrangement.occurrences[1]).toMatchObject({ durationMs: 5000, visualOverrides: null });
    expect(result.arrangement.occurrences[2]).toEqual(arrangement.occurrences[2]);
    // IDs, ordem e documento de origem preservados.
    expect(result.arrangement.occurrences.map((item) => item.id)).toEqual(arrangement.occurrences.map((item) => item.id));
    expect(arrangement.themeRef).toEqual({ kind: 'builtin', presetId: 'grafite' });
  });

  it('campo editado na biblioteca depois da preparação vira conflito e não é sobrescrito', () => {
    const { arrangement: base } = timedSong([8000, null]);
    const [a, b] = base.occurrences.map((item) => item.id) as [string, string];
    const current = {
      ...base,
      fontId: 'roboto',
      occurrences: [{ ...base.occurrences[0]!, text: 'Editado por outra pessoa' }, base.occurrences[1]!],
    };
    let state = applyVisual(emptyOverrides(), 'song', a, { fontId: 'lato', themePresetId: 'vinho' });
    state = applyText(state, a, 'Texto da sessão');
    state = applyText(state, b, 'Segundo da sessão');
    const result = mergeOverridesIntoArrangement(base, state.current, current);
    expect(result.conflicts).toEqual([
      { target: 'arrangement', field: 'font' },
      { target: a, field: 'text' },
    ]);
    expect(result.arrangement).toMatchObject({ fontId: 'roboto', themeRef: { presetId: 'vinho' } });
    expect(result.arrangement.occurrences.map((item) => item.text)).toEqual(['Editado por outra pessoa', 'Segundo da sessão']);
  });

  it('slide removido da biblioteca e ajustes sem lugar no documento ficam só na sessão', () => {
    const { arrangement: base } = timedSong([null, null]);
    const [a, b] = base.occurrences.map((item) => item.id) as [string, string];
    let state = applyVisual(emptyOverrides(), 'occurrence', a, { fontId: 'lato', lineHeight: 1.5 });
    state = applyText(state, b, 'Sumiu');
    const result = mergeOverridesIntoArrangement(base, state.current, { ...base, occurrences: [base.occurrences[0]!] });
    expect(result).toMatchObject({ changed: false, applied: [] });
    expect(result.skipped).toEqual([
      { target: a, field: 'font' },
      { target: a, field: 'lineHeight' },
      { target: b, field: 'text' },
    ]);
    expect(result.arrangement.occurrences).toHaveLength(1);
  });

  it('sem ajustes devolve o mesmo documento', () => {
    const { arrangement } = timedSong([null]);
    const result = mergeOverridesIntoArrangement(arrangement, emptyOverrides().current, arrangement);
    expect(result.changed).toBe(false);
    expect(result.arrangement).toBe(arrangement);
  });

  it('salva o ensaio assistido como padrão de avanço automático', () => {
    const { arrangement } = timedSong([null, null]);
    const result = mergeOverridesIntoArrangement(arrangement, emptyOverrides().current, arrangement, { setDefaultModeAutomatic: true });
    expect(result.arrangement.defaultMode).toBe('automatic');
    expect(result.applied).toContainEqual({ target: 'arrangement', field: 'defaultMode' });
  });
});
