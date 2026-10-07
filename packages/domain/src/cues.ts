import type { ArrangementStructure, AudioCue, SlideOccurrence } from './arrangement';
import type { Uuid } from './common';

type TimedOccurrence = Pick<SlideOccurrence, 'id' | 'order' | 'durationMs'>;

const inSequence = <T extends { order: number }>(occurrences: readonly T[]): T[] => [...occurrences].sort((a, b) => a.order - b.order);

/**
 * Intervalos da faixa derivados dos tempos dos slides (planejamento/06):
 * `inicio[i] = deslocamento + soma(duracao[j], j < i)`. Devolve `null` se
 * alguma ocorrência não tem tempo: ausência de tempo nunca vira zero.
 */
export function deriveCues(occurrences: readonly TimedOccurrence[], offsetMs: number): AudioCue[] | null {
  const cues: AudioCue[] = [];
  let startMs = offsetMs;
  for (const occurrence of inSequence(occurrences)) {
    if (occurrence.durationMs === null) return null;
    cues.push({ occurrenceId: occurrence.id, startMs, endMs: startMs + occurrence.durationMs });
    startMs += occurrence.durationMs;
  }
  return cues;
}

export type LinkIssue =
  | 'no-occurrences'
  | 'missing-duration'
  | 'missing-cue'
  | 'cues-out-of-order'
  | 'negative-offset'
  | 'unknown-track-duration'
  | 'beyond-track-end';

/**
 * O que impede vincular a faixa aos slides. O vínculo exige tempo em todas as
 * ocorrências, um intervalo crescente para cada uma e o último intervalo
 * dentro da duração da gravação.
 */
export function linkIssues(occurrences: readonly TimedOccurrence[], cues: readonly AudioCue[], trackDurationMs: number | null): LinkIssue[] {
  const issues: LinkIssue[] = [];
  const sequence = inSequence(occurrences);
  if (sequence.length === 0) issues.push('no-occurrences');
  if (sequence.some((occurrence) => occurrence.durationMs === null)) issues.push('missing-duration');
  const byOccurrence = new Map(cues.map((cue) => [cue.occurrenceId, cue]));
  const ordered = sequence.map((occurrence) => byOccurrence.get(occurrence.id));
  if (ordered.some((cue) => cue === undefined)) issues.push('missing-cue');
  const present = ordered.filter((cue): cue is AudioCue => cue !== undefined);
  if (present.some((cue, index) => cue.endMs <= cue.startMs || (index > 0 && cue.startMs < (present[index - 1] as AudioCue).endMs))) {
    issues.push('cues-out-of-order');
  }
  if (present.some((cue) => cue.startMs < 0)) issues.push('negative-offset');
  if (trackDurationMs === null) issues.push('unknown-track-duration');
  else if (present.some((cue) => cue.endMs > trackDurationMs)) issues.push('beyond-track-end');
  return issues;
}

/** Intervalos na ordem da sequência; `null` se faltar o de alguma ocorrência. */
export function cuesInSequence(occurrenceIds: readonly Uuid[], cues: readonly AudioCue[]): AudioCue[] | null {
  const byOccurrence = new Map(cues.map((cue) => [cue.occurrenceId, cue]));
  const ordered = occurrenceIds.map((id) => byOccurrence.get(id));
  return ordered.every((cue) => cue !== undefined) ? (ordered as AudioCue[]) : null;
}

/**
 * Índice do intervalo que contém a posição da faixa. Antes do primeiro início
 * vale o primeiro; em um vão entre intervalos, o anterior; depois do último
 * fim, `cues.length` (a sequência terminou).
 */
export function cueIndexAt(cues: readonly AudioCue[], positionMs: number): number {
  if (cues.length === 0) return 0;
  if (positionMs >= (cues[cues.length - 1] as AudioCue).endMs) return cues.length;
  let index = 0;
  for (let next = 1; next < cues.length; next += 1) {
    if (positionMs >= (cues[next] as AudioCue).startMs) index = next;
    else break;
  }
  return index;
}

const sameCues = (a: readonly AudioCue[], b: readonly AudioCue[]) =>
  a.length === b.length && a.every((cue, index) => cue.occurrenceId === b[index]?.occurrenceId && cue.startMs === b[index]?.startMs && cue.endMs === b[index]?.endMs);

/**
 * Mantém as associações de áudio coerentes depois de qualquer edição da
 * sequência ou dos tempos: faixa vinculada recebe os intervalos recalculados;
 * se algum slide ficou sem tempo, ela passa a independente (o vínculo não
 * sobrevive a um tempo ausente). Faixa independente não guarda intervalos.
 * `unlinked` lista as associações que perderam o vínculo.
 */
export function reconcileAudioBindings(structure: ArrangementStructure): { structure: ArrangementStructure; unlinked: Uuid[] } {
  const unlinked: Uuid[] = [];
  let changed = false;
  const audioBindings = structure.audioBindings.map((binding) => {
    const derived = binding.policy === 'linked' ? deriveCues(structure.occurrences, binding.offsetMs) : [];
    if (derived === null) {
      unlinked.push(binding.id);
      changed = true;
      return { ...binding, policy: 'independent' as const, cues: [], cuesVersion: binding.cuesVersion + 1 };
    }
    if (sameCues(binding.cues, derived)) return binding;
    changed = true;
    return { ...binding, cues: derived, cuesVersion: binding.cuesVersion + 1 };
  });
  return { structure: changed ? { ...structure, audioBindings } : structure, unlinked };
}
