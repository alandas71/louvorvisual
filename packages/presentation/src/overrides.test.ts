import { BUNDLED_FONT_IDS, contrastRatio, relativeLuminance, THEME_PRESETS } from '@louvorvisual/domain';
import { describe, expect, it } from 'vitest';
import { applyDuration, applyText, applyVisual, emptyOverrides, OVERRIDES_UNDO_LIMIT, resetVisual, resolveSlide, restoreAppearance, undoOverrides, visualPatchIssues } from './overrides';
import { prepareSnapshot, resolveArrangementVisual } from './snapshot';
import { timedSong } from './testing';

const { snapshot } = timedSong([8000, null, 12_000]);
const [first, second] = snapshot.occurrences as [(typeof snapshot.occurrences)[number], (typeof snapshot.occurrences)[number], unknown];
const resolve = (state: ReturnType<typeof emptyOverrides>, occurrence = first) => resolveSlide(snapshot, state.current, occurrence);

describe('precedência dos ajustes', () => {
  it('sem ajustes vale a base preparada', () => {
    expect(resolve(emptyOverrides())).toMatchObject({ text: first.text, durationMs: 8000, fontId: 'inter', themePresetId: 'grafite', fontChosen: false, style: first.style });
  });

  it('ocorrência vence louvor, que vence a base', () => {
    let state = applyVisual(emptyOverrides(), 'song', first.id, { fontSizePx: 120 });
    expect(resolve(state).style.fontSizePx).toBe(120);
    expect(resolve(state, second).style.fontSizePx).toBe(120);
    state = applyVisual(state, 'occurrence', first.id, { fontSizePx: 64 });
    expect(resolve(state).style.fontSizePx).toBe(64);
    expect(resolve(state, second).style.fontSizePx).toBe(120);
  });

  it('ajuste para o louvor inteiro substitui o que cada slide tinha naquela chave', () => {
    let state = applyVisual(emptyOverrides(), 'occurrence', first.id, { fontSizePx: 64, textAlign: 'left' });
    state = applyVisual(state, 'song', second.id, { fontSizePx: 80 });
    expect(resolve(state).style).toMatchObject({ fontSizePx: 80, textAlign: 'left' });
  });

  it('escopo de ocorrência não vaza para os outros slides', () => {
    const state = applyVisual(emptyOverrides(), 'occurrence', first.id, { themePresetId: 'vinho', fontId: 'lato' });
    expect(resolve(state)).toMatchObject({ themePresetId: 'vinho', fontId: 'lato' });
    expect(resolve(state, second)).toMatchObject({ themePresetId: 'grafite', fontId: 'inter' });
  });
});

describe('tema e fonte', () => {
  it('cada um dos oito temas aplica fundo e letra juntos, escuro e com contraste 7:1', () => {
    for (const preset of THEME_PRESETS) {
      const slide = resolve(applyVisual(emptyOverrides(), 'song', first.id, { themePresetId: preset.presetId }));
      expect(slide.style.palette, preset.presetId).toEqual(preset.style.palette);
      expect(relativeLuminance(slide.style.palette.backgroundColor)).toBeLessThanOrEqual(0.1);
      expect(contrastRatio(slide.style.palette.backgroundColor, slide.style.palette.textColor)).toBeGreaterThanOrEqual(7);
      // Sem fonte manual, a fonte acompanha a inicial do tema.
      expect(slide.fontId, preset.presetId).toBe(preset.initialFontId);
      // Trocar de tema não muda o tamanho escolhido para o arranjo.
      expect(slide.style.fontSizePx).toBe(first.style.fontSizePx);
    }
  });

  it('fonte escolhida manualmente permanece ao trocar o tema; restaurar volta à inicial do tema', () => {
    let state = applyVisual(emptyOverrides(), 'song', first.id, { fontId: 'montserrat' });
    for (const preset of THEME_PRESETS) {
      state = applyVisual(state, 'song', first.id, { themePresetId: preset.presetId });
      expect(resolve(state)).toMatchObject({ fontId: 'montserrat', fontChosen: true });
    }
    state = resetVisual(state, 'song', first.id, ['fontId']);
    expect(resolve(state)).toMatchObject({ fontId: 'atkinson-hyperlegible', themePresetId: 'preto-acessivel', fontChosen: false });
  });

  it('fonte manual gravada no arranjo também é preservada', () => {
    const chosen = timedSong([null], (arrangement) => ({ ...arrangement, fontId: 'lato' })).snapshot;
    const slide = resolveSlide(chosen, applyVisual(emptyOverrides(), 'song', 'x', { themePresetId: 'violeta' }).current, chosen.occurrences[0]!);
    expect(slide).toMatchObject({ fontId: 'lato', fontChosen: true, themePresetId: 'violeta' });
  });

  it('qualquer fonte combina com qualquer tema', () => {
    for (const fontId of BUNDLED_FONT_IDS) {
      const state = applyVisual(emptyOverrides(), 'occurrence', first.id, { fontId, themePresetId: 'ambar' });
      expect(resolve(state)).toMatchObject({ fontId, themePresetId: 'ambar' });
    }
  });

  it('recusa tema, fonte, tamanho e valores fora do catálogo', () => {
    expect(visualPatchIssues({ themePresetId: 'claro' as never })).toEqual(['unknown-theme']);
    expect(visualPatchIssues({ fontId: 'comic' as never })).toEqual(['unknown-font']);
    expect(visualPatchIssues({ fontSizePx: 200 })).toEqual(['font-size-out-of-range']);
    expect(visualPatchIssues({ fontWeight: 500 as never, lineHeight: 5 })).toEqual(['invalid-value']);
    expect(visualPatchIssues({ fontSizePx: 32, fontWeight: 400, textAlign: 'right', verticalAlign: 'top', lineHeight: 0.9 })).toEqual([]);
  });
});

describe('texto, tempo e desfazer', () => {
  it('texto e tempo são por ocorrência; null remove o tempo e ausência mantém o preparado', () => {
    let state = applyText(emptyOverrides(), first.id, 'Texto ao vivo');
    state = applyDuration(state, first.id, null)!;
    expect(resolve(state)).toMatchObject({ text: 'Texto ao vivo', durationMs: null });
    expect(resolve(state, second)).toMatchObject({ text: second.text, durationMs: null });
    state = applyDuration(state, second.id, 5000)!;
    expect(resolve(state, second).durationMs).toBe(5000);
    expect(applyDuration(state, first.id, 0)).toBeNull();
  });

  it('desfazer recupera a aparência anterior e a geração continua crescendo', () => {
    let state = applyVisual(emptyOverrides(), 'song', first.id, { themePresetId: 'violeta' });
    state = applyVisual(state, 'occurrence', first.id, { fontSizePx: 120 });
    expect(state.current.revision).toBe(2);
    state = undoOverrides(state);
    expect(resolve(state)).toMatchObject({ themePresetId: 'violeta', style: { fontSizePx: 96 } });
    expect(state.current.revision).toBe(3);
    state = undoOverrides(undoOverrides(state));
    expect(resolve(state).themePresetId).toBe('grafite');
    expect(state.undo).toHaveLength(0);
  });

  it('o histórico de desfazer é curto', () => {
    let state = emptyOverrides();
    for (let size = 32; size <= 160; size += 4) state = applyVisual(state, 'song', first.id, { fontSizePx: size });
    expect(state.undo).toHaveLength(OVERRIDES_UNDO_LIMIT);
  });

  it('restaurar a aparência preparada mantém texto e tempo aplicados', () => {
    let state = applyVisual(emptyOverrides(), 'song', first.id, { themePresetId: 'violeta', fontId: 'lato' });
    state = applyVisual(state, 'occurrence', first.id, { fontSizePx: 120 });
    state = applyText(state, first.id, 'Fica');
    state = restoreAppearance(state);
    expect(resolve(state)).toMatchObject({ text: 'Fica', themePresetId: 'grafite', fontId: 'inter', style: first.style });
    expect(resolve(undoOverrides(state))).toMatchObject({ themePresetId: 'violeta', style: { fontSizePx: 120 } });
  });
});

describe('snapshot preparado', () => {
  it('copia sequência, textos, tempos, aparência e revisões de origem', () => {
    const { song, arrangement } = timedSong([8000, null]);
    const prepared = prepareSnapshot({ id: 's', now: 'agora', song, arrangement, songGeneration: 4, arrangementGeneration: 7 });
    if (!prepared.ok) throw new Error('esperava snapshot');
    expect(prepared.warnings).toEqual([]);
    expect(prepared.snapshot).toMatchObject({
      song: { id: song.id, title: 'Em União', localGeneration: 4, serverRevision: null },
      arrangement: { id: arrangement.id, localGeneration: 7, defaultMode: 'manual' },
      themePresetId: 'grafite',
      fontId: 'inter',
      fontChosen: false,
      fontPackVersion: '1',
      audio: null,
    });
    expect(prepared.snapshot.occurrences.map(({ id, durationMs }) => [id, durationMs])).toEqual(arrangement.occurrences.map((item) => [item.id, item.durationMs]));
    // Editar a biblioteca depois não muda a sessão.
    arrangement.occurrences[0]!.text = 'Editado depois';
    expect(prepared.snapshot.occurrences[0]!.text).not.toBe('Editado depois');
  });

  it('ordena pela ordem gravada e resolve ajustes do arranjo e da ocorrência', () => {
    const { snapshot: resolved } = timedSong([1000, 2000], (arrangement) => ({
      ...arrangement,
      themeRef: { kind: 'builtin', presetId: 'violeta' },
      themeOverrides: { aspectRatio: '4:3', fontSizePx: 80 },
      occurrences: [
        { ...arrangement.occurrences[0]!, order: 5, visualOverrides: { fontSizePx: 48 } },
        { ...arrangement.occurrences[1]!, order: 2 },
      ],
    }));
    expect(resolved.occurrences.map((item) => item.durationMs)).toEqual([2000, 1000]);
    expect(resolved.occurrences.map((item) => item.style.fontSizePx)).toEqual([80, 48]);
    expect(resolved.occurrences[0]!.style).toMatchObject({ aspectRatio: '4:3', palette: { backgroundColor: '#1B1033' } });
  });

  it('tema indisponível usa Preto acessível e avisa; fonte desconhecida usa a de recuperação', () => {
    const { song, arrangement } = timedSong([null]);
    const prepared = prepareSnapshot({
      id: 's',
      now: 'agora',
      song,
      arrangement: { ...arrangement, themeRef: { kind: 'workspace', themeId: 'tema-da-equipe' }, fontId: 'fonte-removida', fontPackVersion: '0' },
      songGeneration: 1,
      arrangementGeneration: 1,
    });
    if (!prepared.ok) throw new Error('esperava snapshot');
    expect(prepared.warnings).toEqual(['theme-unavailable', 'font-unavailable', 'font-pack-mismatch']);
    expect(prepared.snapshot).toMatchObject({ themePresetId: 'preto-acessivel', fontId: 'inter', fontChosen: true });
    expect(prepared.snapshot.occurrences[0]!.style.palette).toEqual({ backgroundColor: '#000000', textColor: '#FFFFFF' });
  });

  it('recusa sequência vazia, arranjo de outro louvor e documento excluído', () => {
    const { song, arrangement } = timedSong([null]);
    const base = { id: 's', now: 'agora', songGeneration: 1, arrangementGeneration: 1 };
    expect(prepareSnapshot({ ...base, song, arrangement: { ...arrangement, occurrences: [] } })).toEqual({ ok: false, issues: ['empty-sequence'] });
    expect(prepareSnapshot({ ...base, song, arrangement: { ...arrangement, songId: 'outro' } })).toEqual({ ok: false, issues: ['song-mismatch'] });
    expect(prepareSnapshot({ ...base, song: { ...song, deletedAt: 'ontem' }, arrangement })).toEqual({ ok: false, issues: ['deleted'] });
  });

  it('a aparência do editor é a mesma resolução da sessão', () => {
    const { arrangement } = timedSong([null], (item) => ({ ...item, themeRef: { kind: 'builtin', presetId: 'ambar' }, fontId: 'lato' }));
    expect(resolveArrangementVisual(arrangement)).toMatchObject({ preset: { presetId: 'ambar' }, fontId: 'lato', fontChosen: true, themeUnavailable: false });
  });
});
