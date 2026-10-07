import { describe, expect, it } from 'vitest';
import type { ArrangementStructure, AudioBinding, SlideOccurrence } from './arrangement';
import {
  editOccurrenceText,
  equivalentOccurrenceIds,
  formatTimerSeconds,
  mergeOccurrences,
  moveOccurrence,
  parseTimerSeconds,
  removeOccurrences,
  repeatOccurrences,
  setOccurrenceDuration,
  splitOccurrence,
  stepTimerSeconds,
  type EditResult,
} from './editing';
import { sequentialIds } from './testing';

function occurrence(id: string, text: string, durationMs: number | null = null, sourceSectionId: string | null = 'sec'): SlideOccurrence {
  return { id, sourceSectionId, label: 'Trecho', text, order: 0, durationMs, visualKind: 'lyrics', visualOverrides: null };
}

function structure(occurrences: SlideOccurrence[], audioBindings: AudioBinding[] = []): ArrangementStructure {
  return {
    occurrences: occurrences.map((item, order) => ({ ...item, order })),
    audioBindings,
    selectedAudioBindingId: audioBindings[0]?.id ?? null,
  };
}

function linked(cues: AudioBinding['cues']): AudioBinding {
  return { id: 'b1', assetId: 'a1', kind: 'playback', policy: 'linked', volume: 1, offsetMs: 0, cuesVersion: 1, cues };
}

function ok(result: EditResult) {
  if (!result.ok) throw new Error(`operação recusada: ${result.error}`);
  return result;
}

const summary = (value: ArrangementStructure) => value.occurrences.map((item) => [item.id, item.text, item.durationMs, item.order]);
const allText = (value: ArrangementStructure) => value.occurrences.map((item) => item.text).join('\n');

describe('splitOccurrence', () => {
  it('sem tempo, as duas partes ficam null e nenhum texto se perde', () => {
    const base = structure([occurrence('o1', 'a\nb\nc'), occurrence('o2', 'd')]);
    const result = ok(splitOccurrence(base, 'o1', 1, sequentialIds('n')));
    expect(summary(result.structure)).toEqual([
      ['o1', 'a', null, 0],
      ['n-1', 'b\nc', null, 1],
      ['o2', 'd', null, 2],
    ]);
    expect(allText(result.structure)).toBe(allText(base));
    expect(result.createdIds).toEqual(['n-1']);
    expect(result.review).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('com tempo, distribui pelas linhas e conserva a soma', () => {
    const result = ok(splitOccurrence(structure([occurrence('o1', 'a\nb\nc\nd', 12_000)]), 'o1', 1, sequentialIds('n')));
    expect(result.structure.occurrences.map((item) => item.durationMs)).toEqual([3000, 9000]);
  });

  it('respeita o mínimo de 500 ms em cada parte', () => {
    const result = ok(splitOccurrence(structure([occurrence('o1', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 1200)]), 'o1', 1, sequentialIds('n')));
    expect(result.structure.occurrences.map((item) => item.durationMs)).toEqual([500, 700]);
  });

  it('tempo curto demais para dividir: segunda parte sem tempo e pedido de revisão', () => {
    const result = ok(splitOccurrence(structure([occurrence('o1', 'a\nb', 800)]), 'o1', 1, sequentialIds('n')));
    expect(result.structure.occurrences.map((item) => item.durationMs)).toEqual([800, null]);
    expect(result.review).toEqual(['split-duration-needs-review']);
  });

  it('com áudio vinculado, mantém o início da primeira e deriva o da segunda', () => {
    const base = structure(
      [occurrence('o1', 'a\nb', 4000), occurrence('o2', 'c', 3000)],
      [linked([{ occurrenceId: 'o1', startMs: 1000, endMs: 5000 }, { occurrenceId: 'o2', startMs: 5000, endMs: 8000 }])],
    );
    const result = ok(splitOccurrence(base, 'o1', 1, sequentialIds('n')));
    expect(result.structure.audioBindings[0]).toMatchObject({
      cuesVersion: 2,
      cues: [
        { occurrenceId: 'o1', startMs: 1000, endMs: 3000 },
        { occurrenceId: 'n-1', startMs: 3000, endMs: 5000 },
        { occurrenceId: 'o2', startMs: 5000, endMs: 8000 },
      ],
    });
    expect(result.review).toEqual(['cues-need-review']);
    expect(result.issues).toEqual([]);
  });

  it('recusa ponto de divisão fora do texto e ocorrência inexistente', () => {
    const base = structure([occurrence('o1', 'a\nb')]);
    expect(splitOccurrence(base, 'o1', 0, sequentialIds())).toEqual({ ok: false, error: 'invalid-split-point' });
    expect(splitOccurrence(base, 'o1', 2, sequentialIds())).toEqual({ ok: false, error: 'invalid-split-point' });
    expect(splitOccurrence(base, 'zz', 1, sequentialIds())).toEqual({ ok: false, error: 'unknown-occurrence' });
  });
});

describe('mergeOccurrences', () => {
  it('une vizinhos, mantém o primeiro ID e soma os tempos', () => {
    const base = structure([occurrence('o1', 'a', 4000), occurrence('o2', 'b', 3000), occurrence('o3', 'c', 2000)]);
    const result = ok(mergeOccurrences(base, ['o2', 'o1']));
    expect(summary(result.structure)).toEqual([
      ['o1', 'a\nb', 7000, 0],
      ['o3', 'c', 2000, 1],
    ]);
    expect(allText(result.structure)).toBe(allText(base));
  });

  it('se algum não tem tempo, o resultado fica sem temporizador (não zero) e pede revisão', () => {
    const result = ok(mergeOccurrences(structure([occurrence('o1', 'a', 4000), occurrence('o2', 'b')]), ['o1', 'o2']));
    expect(result.structure.occurrences[0]?.durationMs).toBeNull();
    expect(result.review).toEqual(['merge-without-timer']);
  });

  it('todos sem tempo: une sem aviso', () => {
    expect(ok(mergeOccurrences(structure([occurrence('o1', 'a'), occurrence('o2', 'b')]), ['o1', 'o2'])).review).toEqual([]);
  });

  it('valida o limite antes de aplicar', () => {
    const base = structure([occurrence('o1', 'a', 400_000), occurrence('o2', 'b', 300_000)]);
    expect(mergeOccurrences(base, ['o1', 'o2'])).toEqual({ ok: false, error: 'duration-exceeds-limit' });
  });

  it('recusa slides que não são vizinhos ou seleção de um só', () => {
    const base = structure([occurrence('o1', 'a'), occurrence('o2', 'b'), occurrence('o3', 'c')]);
    expect(mergeOccurrences(base, ['o1', 'o3'])).toEqual({ ok: false, error: 'not-adjacent' });
    expect(mergeOccurrences(base, ['o1'])).toEqual({ ok: false, error: 'merge-needs-two' });
  });

  it('seções de origem diferentes deixam a união sem seção de origem', () => {
    const result = ok(mergeOccurrences(structure([occurrence('o1', 'a', null, 's1'), occurrence('o2', 'b', null, 's2')]), ['o1', 'o2']));
    expect(result.structure.occurrences[0]?.sourceSectionId).toBeNull();
  });

  it('une também as marcações de áudio', () => {
    const base = structure(
      [occurrence('o1', 'a', 4000), occurrence('o2', 'b', 3000), occurrence('o3', 'c', 2000)],
      [
        linked([
          { occurrenceId: 'o1', startMs: 0, endMs: 4000 },
          { occurrenceId: 'o2', startMs: 4000, endMs: 7000 },
          { occurrenceId: 'o3', startMs: 7000, endMs: 9000 },
        ]),
      ],
    );
    const result = ok(mergeOccurrences(base, ['o2', 'o3']));
    expect(result.structure.audioBindings[0]?.cues).toEqual([
      { occurrenceId: 'o1', startMs: 0, endMs: 4000 },
      { occurrenceId: 'o2', startMs: 4000, endMs: 9000 },
    ]);
    expect(result.issues).toEqual([]);
  });
});

describe('repeatOccurrences', () => {
  it('cria cópias com IDs novos logo depois do trecho, com os valores iniciais', () => {
    const base = structure([occurrence('o1', 'estrofe'), occurrence('o2', 'refrão', 8000), occurrence('o3', 'ponte')]);
    const result = ok(repeatOccurrences(base, ['o2'], sequentialIds('n')));
    expect(summary(result.structure)).toEqual([
      ['o1', 'estrofe', null, 0],
      ['o2', 'refrão', 8000, 1],
      ['n-1', 'refrão', 8000, 2],
      ['o3', 'ponte', null, 3],
    ]);
  });

  it('o tempo da repetição é independente do original', () => {
    const repeated = ok(repeatOccurrences(structure([occurrence('o1', 'refrão', 8000)]), ['o1'], sequentialIds('n'))).structure;
    const changed = ok(setOccurrenceDuration(repeated, ['n-1'], 12_000)).structure;
    expect(changed.occurrences.map((item) => [item.id, item.durationMs])).toEqual([
      ['o1', 8000],
      ['n-1', 12_000],
    ]);
    const cleared = ok(setOccurrenceDuration(changed, ['o1'], null)).structure;
    expect(cleared.occurrences.map((item) => item.durationMs)).toEqual([null, 12_000]);
  });

  it('repetir com áudio vinculado aponta a marcação que falta', () => {
    const base = structure([occurrence('o1', 'a', 4000)], [linked([{ occurrenceId: 'o1', startMs: 0, endMs: 4000 }])]);
    const result = ok(repeatOccurrences(base, ['o1'], sequentialIds('n')));
    expect(result.review).toEqual(['cues-need-review']);
    expect(result.issues.map((issue) => issue.code)).toEqual(['linked-binding-missing-cue']);
  });
});

describe('moveOccurrence', () => {
  const base = structure([occurrence('o1', 'a', 1000), occurrence('o2', 'b'), occurrence('o3', 'c', 3000)]);

  it('reordena sem trocar IDs, textos ou tempos', () => {
    expect(summary(ok(moveOccurrence(base, 'o3', 0)).structure)).toEqual([
      ['o3', 'c', 3000, 0],
      ['o1', 'a', 1000, 1],
      ['o2', 'b', null, 2],
    ]);
    expect(summary(ok(moveOccurrence(base, 'o1', 99)).structure).map((item) => item[0])).toEqual(['o2', 'o3', 'o1']);
  });

  it('sinaliza marcações de áudio fora da nova ordem', () => {
    const cued = structure(
      [occurrence('o1', 'a', 1000), occurrence('o2', 'b', 1000)],
      [linked([{ occurrenceId: 'o1', startMs: 0, endMs: 1000 }, { occurrenceId: 'o2', startMs: 1000, endMs: 2000 }])],
    );
    expect(ok(moveOccurrence(cued, 'o2', 0)).review).toEqual(['cue-order-mismatch']);
    expect(ok(moveOccurrence(cued, 'o2', 1)).review).toEqual([]);
  });
});

describe('editOccurrenceText e equivalentes', () => {
  const base = structure([occurrence('o1', 'refrão'), occurrence('o2', 'estrofe'), occurrence('o3', 'refrão', 5000)]);

  it('edita só a ocorrência escolhida', () => {
    const result = ok(editOccurrenceText(base, ['o1'], 'refrão novo'));
    expect(result.structure.occurrences.map((item) => item.text)).toEqual(['refrão novo', 'estrofe', 'refrão']);
  });

  it('lista as ocorrências com o mesmo texto para aplicar junto', () => {
    expect(equivalentOccurrenceIds(base, 'o1')).toEqual(['o3']);
    const result = ok(editOccurrenceText(base, ['o1', 'o3'], 'refrão novo'));
    expect(result.structure.occurrences.map((item) => [item.text, item.durationMs])).toEqual([
      ['refrão novo', null],
      ['estrofe', null],
      ['refrão novo', 5000],
    ]);
  });

  it('texto vazio vira slide instrumental e volta a letra ao receber texto', () => {
    const empty = ok(editOccurrenceText(base, ['o2'], '')).structure;
    expect(empty.occurrences[1]?.visualKind).toBe('instrumental');
    expect(ok(editOccurrenceText(empty, ['o2'], 'voltou')).structure.occurrences[1]?.visualKind).toBe('lyrics');
  });
});

describe('removeOccurrences', () => {
  it('remove e renumera; marcações da ocorrência saem junto', () => {
    const base = structure(
      [occurrence('o1', 'a', 1000), occurrence('o2', 'b', 1000)],
      [linked([{ occurrenceId: 'o1', startMs: 0, endMs: 1000 }, { occurrenceId: 'o2', startMs: 1000, endMs: 2000 }])],
    );
    const result = ok(removeOccurrences(base, ['o1']));
    expect(summary(result.structure)).toEqual([['o2', 'b', 1000, 0]]);
    expect(result.structure.audioBindings[0]?.cues).toEqual([{ occurrenceId: 'o2', startMs: 1000, endMs: 2000 }]);
    expect(result.issues).toEqual([]);
  });
});

describe('setOccurrenceDuration', () => {
  const base = structure([occurrence('o1', 'a'), occurrence('o2', 'b'), occurrence('o3', 'c')]);

  it('aplica apenas aos escolhidos', () => {
    expect(ok(setOccurrenceDuration(base, ['o1', 'o3'], 8000)).structure.occurrences.map((item) => item.durationMs)).toEqual([8000, null, 8000]);
  });

  it('recusa zero, fracionário e fora de 500–600000 ms', () => {
    for (const value of [0, 499, 600_001, 1000.5]) {
      expect(setOccurrenceDuration(base, ['o1'], value)).toEqual({ ok: false, error: 'invalid-duration' });
    }
  });
});

describe('campo de segundos', () => {
  it('converte para milissegundos inteiros, com vírgula ou ponto', () => {
    expect(parseTimerSeconds('8')).toBe(8000);
    expect(parseTimerSeconds(' 0,5 ')).toBe(500);
    expect(parseTimerSeconds('12.5')).toBe(12_500);
    expect(parseTimerSeconds('600')).toBe(600_000);
    expect(parseTimerSeconds('1,2345')).toBe(1235);
  });

  it('vazio, zero, texto e fora do intervalo são inválidos: nunca viram zero', () => {
    for (const text of ['', '0', '0,4', '601', 'abc', '-3', '1e3']) expect(parseTimerSeconds(text)).toBeNull();
  });

  it('formata e ajusta com −/+ dentro dos limites', () => {
    expect(formatTimerSeconds(8000)).toBe('8');
    expect(formatTimerSeconds(500)).toBe('0,5');
    expect(stepTimerSeconds('8', 1)).toBe('9');
    expect(stepTimerSeconds('0,5', -1)).toBe('0,5');
    expect(stepTimerSeconds('600', 1)).toBe('600');
    expect(stepTimerSeconds('', 1)).toBe('9');
  });
});
