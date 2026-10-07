import { describe, expect, it } from 'vitest';
import { arrangementIssues, isValidOccurrenceDuration, type AudioBinding, type SlideOccurrence } from './arrangement';

function occurrence(id: string, order: number, durationMs: number | null = null): SlideOccurrence {
  return { id, sourceSectionId: null, label: id, text: id, order, durationMs, visualKind: 'lyrics', visualOverrides: null };
}

function binding(overrides: Partial<AudioBinding> = {}): AudioBinding {
  return {
    id: 'b1',
    assetId: 'a1',
    kind: 'playback',
    policy: 'independent',
    volume: 1,
    offsetMs: 0,
    cuesVersion: 1,
    cues: [],
    ...overrides,
  };
}

function codes(...args: Parameters<typeof arrangementIssues>) {
  return arrangementIssues(...args).map((issue) => issue.code);
}

describe('isValidOccurrenceDuration', () => {
  it('aceita null e inteiros entre 500 e 600000 ms', () => {
    expect(isValidOccurrenceDuration(null)).toBe(true);
    expect(isValidOccurrenceDuration(500)).toBe(true);
    expect(isValidOccurrenceDuration(600_000)).toBe(true);
  });

  it('rejeita zero, fora do intervalo e fracionários', () => {
    expect(isValidOccurrenceDuration(0)).toBe(false);
    expect(isValidOccurrenceDuration(499)).toBe(false);
    expect(isValidOccurrenceDuration(600_001)).toBe(false);
    expect(isValidOccurrenceDuration(1000.5)).toBe(false);
  });
});

describe('arrangementIssues', () => {
  it('aceita sequência sem tempo e sem áudio', () => {
    expect(
      arrangementIssues({
        occurrences: [occurrence('o1', 0), occurrence('o2', 1)],
        audioBindings: [],
        selectedAudioBindingId: null,
      }),
    ).toEqual([]);
  });

  it('aponta IDs e ordens repetidos com o caminho do campo', () => {
    expect(
      arrangementIssues({
        occurrences: [occurrence('o1', 0), occurrence('o1', 0)],
        audioBindings: [],
        selectedAudioBindingId: null,
      }),
    ).toEqual([
      { code: 'duplicate-occurrence-id', path: ['occurrences', 1, 'id'] },
      { code: 'duplicate-occurrence-order', path: ['occurrences', 1, 'order'] },
    ]);
  });

  it('exige que a faixa selecionada exista', () => {
    expect(codes({ occurrences: [], audioBindings: [], selectedAudioBindingId: 'b9' })).toEqual([
      'unknown-selected-binding',
    ]);
  });

  it('valida cues: ocorrência existente, intervalo positivo e inícios crescentes', () => {
    expect(
      codes({
        occurrences: [occurrence('o1', 0), occurrence('o2', 1)],
        audioBindings: [
          binding({
            cues: [
              { occurrenceId: 'o1', startMs: 1000, endMs: 2000 },
              { occurrenceId: 'o9', startMs: 1000, endMs: 900 },
            ],
          }),
        ],
        selectedAudioBindingId: 'b1',
      }),
    ).toEqual(['cue-unknown-occurrence', 'cue-invalid-interval', 'cues-not-increasing']);
  });

  it('vínculo exige duração e cue em todas as ocorrências', () => {
    expect(
      codes({
        occurrences: [occurrence('o1', 0, 4000), occurrence('o2', 1, null)],
        audioBindings: [binding({ policy: 'linked', cues: [{ occurrenceId: 'o1', startMs: 0, endMs: 4000 }] })],
        selectedAudioBindingId: 'b1',
      }),
    ).toEqual(['linked-binding-missing-duration', 'linked-binding-missing-cue']);
  });

  it('aceita vínculo completo', () => {
    expect(
      arrangementIssues({
        occurrences: [occurrence('o1', 0, 4000), occurrence('o2', 1, 3000)],
        audioBindings: [
          binding({
            policy: 'linked',
            cues: [
              { occurrenceId: 'o1', startMs: 0, endMs: 4000 },
              { occurrenceId: 'o2', startMs: 4000, endMs: 7000 },
            ],
          }),
        ],
        selectedAudioBindingId: 'b1',
      }),
    ).toEqual([]);
  });
});
