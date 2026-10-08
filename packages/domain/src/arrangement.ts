import type { AggregateMeta, Revision, Uuid } from './common';
import type { ThemeOverrides, ThemeRef, ThemeStyle } from './theme';

/** Duração de uma ocorrência: inteiro em ms dentro do intervalo, ou `null` para aguardar o operador. */
export const OCCURRENCE_DURATION_MS = { min: 500, max: 600_000 } as const;

export const OCCURRENCE_VISUAL_KINDS = ['lyrics', 'instrumental'] as const;
export type OccurrenceVisualKind = (typeof OCCURRENCE_VISUAL_KINDS)[number];

export const PRESENTATION_MODES = ['manual', 'automatic'] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];

export const AUDIO_KINDS = ['original', 'playback'] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

/** Independente: transporte próprio. Vinculado: áudio e slides seguem os mesmos intervalos. */
export const AUDIO_POLICIES = ['independent', 'linked'] as const;
export type AudioPolicy = (typeof AUDIO_POLICIES)[number];

export type OccurrenceVisualOverrides = Partial<
  Pick<ThemeStyle, 'palette' | 'fontSizePx' | 'fontWeight' | 'textAlign' | 'verticalAlign'>
>;

/** Uma aparição na sequência; o ID é estável e não equivale ao índice. */
export type SlideOccurrence = {
  id: Uuid;
  sourceSectionId: Uuid | null;
  label: string;
  text: string;
  order: number;
  durationMs: number | null;
  visualKind: OccurrenceVisualKind;
  visualOverrides: OccurrenceVisualOverrides | null;
};

export type AudioCue = {
  occurrenceId: Uuid;
  startMs: number;
  endMs: number;
};

export type AudioBinding = {
  id: Uuid;
  assetId: Uuid;
  kind: AudioKind;
  policy: AudioPolicy;
  volume: number;
  offsetMs: number;
  cuesVersion: number;
  cues: AudioCue[];
};

export type Arrangement = AggregateMeta & {
  id: Uuid;
  songId: Uuid;
  name: string;
  basedOnSongRevision: Revision | null;
  themeRef: ThemeRef;
  themeOverrides: ThemeOverrides | null;
  /** Preenchido apenas quando a fonte foi escolhida manualmente. */
  fontId: string | null;
  fontPackVersion: string;
  occurrences: SlideOccurrence[];
  audioBindings: AudioBinding[];
  selectedAudioBindingId: Uuid | null;
  defaultMode: PresentationMode;
  /**
   * Temporizador da introdução: o tempo da música (posição da faixa) em que a
   * abertura dá lugar à letra sozinha, no modo automático; sem faixa, conta desde
   * o início da apresentação. Ausente ou `null`: a abertura espera o operador.
   */
  introDurationMs?: number | null;
};

export function isValidOccurrenceDuration(durationMs: number | null): boolean {
  if (durationMs === null) return true;
  return (
    Number.isInteger(durationMs) &&
    durationMs >= OCCURRENCE_DURATION_MS.min &&
    durationMs <= OCCURRENCE_DURATION_MS.max
  );
}

export type ArrangementIssueCode =
  | 'duplicate-occurrence-id'
  | 'duplicate-occurrence-order'
  | 'invalid-duration'
  | 'duplicate-binding-id'
  | 'unknown-selected-binding'
  | 'cue-unknown-occurrence'
  | 'cue-invalid-interval'
  | 'cues-not-increasing'
  | 'linked-binding-missing-duration'
  | 'linked-binding-missing-cue';

export type ArrangementIssue = {
  code: ArrangementIssueCode;
  /** Caminho do campo no documento, no formato usado pelos esquemas. */
  path: (string | number)[];
};

/** Parte do arranjo coberta pelas invariantes e alterada pelas operações do editor. */
export type ArrangementStructure = Pick<Arrangement, 'occurrences' | 'audioBindings' | 'selectedAudioBindingId'>;

/**
 * Invariantes do agregado (planejamento/11) que dependem de mais de um campo.
 * Referências a outros agregados (louvor, arquivos do mesmo espaço) são
 * verificadas por quem tem acesso ao repositório.
 */
export function arrangementIssues(arrangement: ArrangementStructure): ArrangementIssue[] {
  const issues: ArrangementIssue[] = [];
  const { occurrences, audioBindings, selectedAudioBindingId } = arrangement;

  const occurrenceIds = new Set<Uuid>();
  const orders = new Set<number>();
  occurrences.forEach((occurrence, index) => {
    if (occurrenceIds.has(occurrence.id)) {
      issues.push({ code: 'duplicate-occurrence-id', path: ['occurrences', index, 'id'] });
    }
    occurrenceIds.add(occurrence.id);
    if (orders.has(occurrence.order)) {
      issues.push({ code: 'duplicate-occurrence-order', path: ['occurrences', index, 'order'] });
    }
    orders.add(occurrence.order);
    if (!isValidOccurrenceDuration(occurrence.durationMs)) {
      issues.push({ code: 'invalid-duration', path: ['occurrences', index, 'durationMs'] });
    }
  });

  const bindingIds = new Set<Uuid>();
  audioBindings.forEach((binding, bindingIndex) => {
    const bindingPath = ['audioBindings', bindingIndex];
    if (bindingIds.has(binding.id)) {
      issues.push({ code: 'duplicate-binding-id', path: [...bindingPath, 'id'] });
    }
    bindingIds.add(binding.id);

    const cuedOccurrences = new Set<Uuid>();
    let previousStart = -Infinity;
    binding.cues.forEach((cue, cueIndex) => {
      const cuePath = [...bindingPath, 'cues', cueIndex];
      if (!occurrenceIds.has(cue.occurrenceId)) {
        issues.push({ code: 'cue-unknown-occurrence', path: [...cuePath, 'occurrenceId'] });
      }
      cuedOccurrences.add(cue.occurrenceId);
      if (cue.endMs <= cue.startMs) {
        issues.push({ code: 'cue-invalid-interval', path: [...cuePath, 'endMs'] });
      }
      if (cue.startMs <= previousStart) {
        issues.push({ code: 'cues-not-increasing', path: [...cuePath, 'startMs'] });
      }
      previousStart = cue.startMs;
    });

    // Vínculo exige tempos completos; ausência de tempo nunca vira zero.
    if (binding.policy === 'linked') {
      occurrences.forEach((occurrence, index) => {
        if (occurrence.durationMs === null) {
          issues.push({ code: 'linked-binding-missing-duration', path: ['occurrences', index, 'durationMs'] });
        }
        if (!cuedOccurrences.has(occurrence.id)) {
          issues.push({ code: 'linked-binding-missing-cue', path: [...bindingPath, 'cues'] });
        }
      });
    }
  });

  if (selectedAudioBindingId !== null && !bindingIds.has(selectedAudioBindingId)) {
    issues.push({ code: 'unknown-selected-binding', path: ['selectedAudioBindingId'] });
  }

  return issues;
}
