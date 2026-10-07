import { describe, expect, it } from 'vitest';
import type { ArrangementStructure, AudioBinding, SlideOccurrence } from './arrangement';
import { cueIndexAt, cuesInSequence, deriveCues, linkIssues, reconcileAudioBindings } from './cues';

const occurrence = (id: string, order: number, durationMs: number | null): SlideOccurrence => ({
  id,
  sourceSectionId: null,
  label: id,
  text: id,
  order,
  durationMs,
  visualKind: 'lyrics',
  visualOverrides: null,
});
const binding = (fields: Partial<AudioBinding> = {}): AudioBinding => ({ id: 'faixa', assetId: 'arquivo', kind: 'playback', policy: 'linked', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [], ...fields });

describe('intervalos derivados dos tempos', () => {
  it('reproduz o exemplo do planejamento: deslocamento de 5 s e durações de 8, 12 e 10 s', () => {
    const cues = deriveCues([occurrence('a', 0, 8000), occurrence('b', 1, 12_000), occurrence('c', 2, 10_000)], 5000);
    expect(cues).toEqual([
      { occurrenceId: 'a', startMs: 5000, endMs: 13_000 },
      { occurrenceId: 'b', startMs: 13_000, endMs: 25_000 },
      { occurrenceId: 'c', startMs: 25_000, endMs: 35_000 },
    ]);
  });

  it('segue a ordem da sequência, não a do vetor, e não inventa tempo para slide sem duração', () => {
    expect(deriveCues([occurrence('b', 1, 2000), occurrence('a', 0, 1000)], 0)?.map((cue) => cue.occurrenceId)).toEqual(['a', 'b']);
    expect(deriveCues([occurrence('a', 0, 1000), occurrence('b', 1, null)], 0)).toBeNull();
  });
});

describe('condições do vínculo', () => {
  const sequence = [occurrence('a', 0, 8000), occurrence('b', 1, 12_000), occurrence('c', 2, 10_000)];
  const cues = deriveCues(sequence, 5000)!;

  it('aceita intervalos completos dentro da gravação', () => {
    expect(linkIssues(sequence, cues, 35_000)).toEqual([]);
  });

  it('impede o vínculo quando o último intervalo passa do fim da faixa ou a duração é desconhecida', () => {
    expect(linkIssues(sequence, cues, 34_999)).toEqual(['beyond-track-end']);
    expect(linkIssues(sequence, cues, null)).toEqual(['unknown-track-duration']);
  });

  it('aponta tempo ausente, intervalo ausente, ordem errada e deslocamento negativo', () => {
    expect(linkIssues([...sequence, occurrence('d', 3, null)], cues, 60_000)).toEqual(['missing-duration', 'missing-cue']);
    expect(linkIssues(sequence, [cues[0]!, { ...cues[1]!, startMs: 12_000 }, cues[2]!], 60_000)).toEqual(['cues-out-of-order']);
    expect(linkIssues(sequence, deriveCues(sequence, -1000)!, 60_000)).toEqual(['negative-offset']);
    expect(linkIssues([], [], 60_000)).toEqual(['no-occurrences']);
  });

  it('marcações de outra gravação não servem: troca de faixa exige intervalos para as ocorrências atuais', () => {
    const other = [occurrence('x', 0, 8000), occurrence('y', 1, 12_000)];
    expect(linkIssues(other, cues, 60_000)).toContain('missing-cue');
    expect(cuesInSequence(['x', 'y'], cues)).toBeNull();
    expect(cuesInSequence(['c', 'a'], cues)?.map((cue) => cue.startMs)).toEqual([25_000, 5000]);
  });
});

describe('ocorrência pela posição da faixa', () => {
  const cues = deriveCues([occurrence('a', 0, 8000), occurrence('b', 1, 12_000), occurrence('c', 2, 10_000)], 5000)!;

  it('seleciona o intervalo que contém a posição', () => {
    expect(cueIndexAt(cues, 0)).toBe(0);
    expect(cueIndexAt(cues, 5000)).toBe(0);
    expect(cueIndexAt(cues, 12_999)).toBe(0);
    expect(cueIndexAt(cues, 13_000)).toBe(1);
    expect(cueIndexAt(cues, 24_999)).toBe(1);
    expect(cueIndexAt(cues, 25_000)).toBe(2);
    expect(cueIndexAt(cues, 34_999)).toBe(2);
  });

  it('depois do último fim, a sequência terminou', () => {
    expect(cueIndexAt(cues, 35_000)).toBe(3);
    expect(cueIndexAt([], 10)).toBe(0);
  });
});

describe('associações de áudio depois de editar a sequência', () => {
  const structure = (occurrences: SlideOccurrence[], bindings: AudioBinding[]): ArrangementStructure => ({ occurrences, audioBindings: bindings, selectedAudioBindingId: bindings[0]?.id ?? null });

  it('recalcula os intervalos da faixa vinculada e avança a versão das marcações', () => {
    const before = structure([occurrence('a', 0, 8000), occurrence('b', 1, 12_000)], [binding({ offsetMs: 5000 })]);
    const first = reconcileAudioBindings(before);
    expect(first.unlinked).toEqual([]);
    expect(first.structure.audioBindings[0]).toMatchObject({ policy: 'linked', cuesVersion: 1, cues: [{ occurrenceId: 'a', startMs: 5000, endMs: 13_000 }, { occurrenceId: 'b', startMs: 13_000, endMs: 25_000 }] });
    // Sem mudança, o documento não é tocado.
    expect(reconcileAudioBindings(first.structure).structure).toBe(first.structure);

    const edited = { ...first.structure, occurrences: [occurrence('a', 0, 6000), occurrence('b', 1, 12_000)] };
    const second = reconcileAudioBindings(edited);
    expect(second.structure.audioBindings[0]).toMatchObject({ cuesVersion: 2, cues: [{ startMs: 5000, endMs: 11_000 }, { startMs: 11_000, endMs: 23_000 }] });
  });

  it('slide sem tempo desfaz o vínculo em vez de virar zero', () => {
    const linked = reconcileAudioBindings(structure([occurrence('a', 0, 8000), occurrence('b', 1, 12_000)], [binding()])).structure;
    const result = reconcileAudioBindings({ ...linked, occurrences: [occurrence('a', 0, 8000), occurrence('b', 1, null)] });
    expect(result.unlinked).toEqual(['faixa']);
    expect(result.structure.audioBindings[0]).toMatchObject({ policy: 'independent', cues: [] });
  });

  it('faixa independente não guarda intervalos', () => {
    const result = reconcileAudioBindings(structure([occurrence('a', 0, null)], [binding({ policy: 'independent', cues: [{ occurrenceId: 'a', startMs: 0, endMs: 10 }] })]));
    expect(result.unlinked).toEqual([]);
    expect(result.structure.audioBindings[0]).toMatchObject({ policy: 'independent', cues: [], cuesVersion: 1 });
  });
});
