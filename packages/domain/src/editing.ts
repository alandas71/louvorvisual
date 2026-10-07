import {
  arrangementIssues,
  isValidOccurrenceDuration,
  OCCURRENCE_DURATION_MS,
  type ArrangementIssue,
  type ArrangementStructure,
  type AudioBinding,
  type AudioCue,
  type SlideOccurrence,
} from './arrangement';
import type { Uuid } from './common';
import { MAX_OCCURRENCES } from './slides';

/** Sugestão ao adicionar tempo; só vale depois de aplicada. */
export const TIMER_SUGGESTION_MS = 8000;
/** Passo dos botões −/+ do campo de tempo. */
export const TIMER_STEP_MS = 1000;

export type EditErrorCode =
  | 'unknown-occurrence'
  | 'invalid-split-point'
  | 'merge-needs-two'
  | 'not-adjacent'
  | 'duration-exceeds-limit'
  | 'invalid-duration'
  | 'occurrence-limit';

export type EditReviewCode =
  /** Tempo curto demais para dividir respeitando o mínimo; a segunda parte ficou sem tempo. */
  | 'split-duration-needs-review'
  /** Algum slide unido não tinha tempo; o resultado ficou sem temporizador. */
  | 'merge-without-timer'
  /** Marcações de áudio foram derivadas ou removidas pela operação. */
  | 'cues-need-review'
  /** A ordem dos slides deixou de acompanhar a ordem das marcações de áudio. */
  | 'cue-order-mismatch';

export type EditResult =
  | {
      ok: true;
      structure: ArrangementStructure;
      /** Pontos que o editor mostra para revisão humana. */
      review: EditReviewCode[];
      /** Invariantes do agregado após a operação; vazio quando o resultado pode ser salvo. */
      issues: ArrangementIssue[];
      /** IDs criados pela operação, na ordem em que entraram na sequência. */
      createdIds: Uuid[];
    }
  | { ok: false; error: EditErrorCode };

function inOrder(occurrences: readonly SlideOccurrence[]): SlideOccurrence[] {
  return [...occurrences].sort((a, b) => a.order - b.order);
}

function renumber(occurrences: readonly SlideOccurrence[]): SlideOccurrence[] {
  return occurrences.map((occurrence, order) => (occurrence.order === order ? occurrence : { ...occurrence, order }));
}

function done(
  base: ArrangementStructure,
  occurrences: SlideOccurrence[],
  audioBindings: AudioBinding[],
  review: EditReviewCode[],
  createdIds: Uuid[] = [],
): EditResult {
  const structure = { ...base, occurrences: renumber(occurrences), audioBindings };
  return { ok: true, structure, review: [...new Set(review)], issues: arrangementIssues(structure), createdIds };
}

/** Aplica uma transformação às marcações de cada faixa; avisa quando alguma mudou. */
function mapCues(
  bindings: readonly AudioBinding[],
  transform: (cues: AudioCue[]) => AudioCue[] | null,
): { bindings: AudioBinding[]; changed: boolean } {
  let changed = false;
  const result = bindings.map((binding) => {
    const cues = transform(binding.cues);
    if (!cues) return binding;
    changed = true;
    return { ...binding, cues, cuesVersion: binding.cuesVersion + 1 };
  });
  return { bindings: result, changed };
}

function hasCues(structure: ArrangementStructure): boolean {
  return structure.audioBindings.some((binding) => binding.cues.length > 0);
}

function visualKindFor(text: string): SlideOccurrence['visualKind'] {
  return text.trim() === '' ? 'instrumental' : 'lyrics';
}

/** Outras ocorrências com exatamente o mesmo texto: candidatas a receber a mesma edição. */
export function equivalentOccurrenceIds(structure: ArrangementStructure, id: Uuid): Uuid[] {
  const source = structure.occurrences.find((occurrence) => occurrence.id === id);
  if (!source) return [];
  return inOrder(structure.occurrences)
    .filter((occurrence) => occurrence.id !== id && occurrence.text === source.text)
    .map((occurrence) => occurrence.id);
}

/** Altera o texto das ocorrências indicadas; as demais repetições ficam como estão. */
export function editOccurrenceText(structure: ArrangementStructure, ids: readonly Uuid[], text: string): EditResult {
  const targets = new Set(ids);
  if (ids.length === 0 || ids.some((id) => !structure.occurrences.some((occurrence) => occurrence.id === id))) {
    return { ok: false, error: 'unknown-occurrence' };
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  const occurrences = inOrder(structure.occurrences).map((occurrence) =>
    targets.has(occurrence.id) ? { ...occurrence, text: normalized, visualKind: visualKindFor(normalized) } : occurrence,
  );
  return done(structure, occurrences, structure.audioBindings, []);
}

/**
 * Divide antes da linha `lineIndex` (1 = depois da primeira linha). Sem tempo,
 * as duas partes ficam `null`; com tempo, ele é distribuído pelas linhas
 * respeitando o mínimo por slide.
 */
export function splitOccurrence(structure: ArrangementStructure, id: Uuid, lineIndex: number, newId: () => Uuid): EditResult {
  const occurrences = inOrder(structure.occurrences);
  const index = occurrences.findIndex((occurrence) => occurrence.id === id);
  const source = occurrences[index];
  if (!source) return { ok: false, error: 'unknown-occurrence' };
  const lines = source.text.split('\n');
  if (!Number.isInteger(lineIndex) || lineIndex < 1 || lineIndex >= lines.length) return { ok: false, error: 'invalid-split-point' };
  if (occurrences.length >= MAX_OCCURRENCES) return { ok: false, error: 'occurrence-limit' };

  const review: EditReviewCode[] = [];
  const ratio = lineIndex / lines.length;
  const { min } = OCCURRENCE_DURATION_MS;
  let firstDuration: number | null = null;
  let secondDuration: number | null = null;
  if (source.durationMs !== null) {
    if (source.durationMs >= 2 * min) {
      firstDuration = Math.min(source.durationMs - min, Math.max(min, Math.round(source.durationMs * ratio)));
      secondDuration = source.durationMs - firstDuration;
    } else {
      // Não há como dar o mínimo às duas partes: a ausência de tempo fica explícita.
      firstDuration = source.durationMs;
      review.push('split-duration-needs-review');
    }
  }

  const firstText = lines.slice(0, lineIndex).join('\n');
  const secondText = lines.slice(lineIndex).join('\n');
  const first: SlideOccurrence = { ...source, text: firstText, durationMs: firstDuration, visualKind: visualKindFor(firstText) };
  const second: SlideOccurrence = {
    ...source,
    id: newId(),
    text: secondText,
    durationMs: secondDuration,
    visualKind: visualKindFor(secondText),
  };

  // Mantém o início da primeira parte e deriva o início da segunda.
  const cues = mapCues(structure.audioBindings, (current) => {
    const cueIndex = current.findIndex((cue) => cue.occurrenceId === id);
    const cue = current[cueIndex];
    if (!cue) return null;
    const length = cue.endMs - cue.startMs;
    const offset = secondDuration !== null && firstDuration !== null && firstDuration < length ? firstDuration : Math.round(length * ratio);
    const middle = cue.startMs + Math.min(Math.max(offset, 1), Math.max(1, length - 1));
    return [
      ...current.slice(0, cueIndex),
      { ...cue, endMs: middle },
      { occurrenceId: second.id, startMs: middle, endMs: cue.endMs },
      ...current.slice(cueIndex + 1),
    ];
  });
  if (cues.changed) review.push('cues-need-review');

  return done(structure, [...occurrences.slice(0, index), first, second, ...occurrences.slice(index + 1)], cues.bindings, review, [second.id]);
}

/**
 * Une ocorrências vizinhas em uma só, mantendo o ID da primeira. Soma os tempos
 * quando todos existem; se algum falta, o resultado fica sem temporizador.
 */
export function mergeOccurrences(structure: ArrangementStructure, ids: readonly Uuid[]): EditResult {
  const occurrences = inOrder(structure.occurrences);
  const selected = new Set(ids);
  if (selected.size < 2) return { ok: false, error: 'merge-needs-two' };
  const indexes = occurrences.flatMap((occurrence, index) => (selected.has(occurrence.id) ? [index] : []));
  if (indexes.length !== selected.size) return { ok: false, error: 'unknown-occurrence' };
  const start = indexes[0] as number;
  if (indexes.some((value, position) => value !== start + position)) return { ok: false, error: 'not-adjacent' };

  const parts = occurrences.slice(start, start + indexes.length);
  const first = parts[0] as SlideOccurrence;
  const review: EditReviewCode[] = [];
  let durationMs: number | null = null;
  if (parts.every((part) => part.durationMs !== null)) {
    durationMs = parts.reduce((sum, part) => sum + (part.durationMs ?? 0), 0);
    if (durationMs > OCCURRENCE_DURATION_MS.max) return { ok: false, error: 'duration-exceeds-limit' };
  } else if (parts.some((part) => part.durationMs !== null)) {
    review.push('merge-without-timer');
  }

  const text = parts.map((part) => part.text).join('\n');
  const merged: SlideOccurrence = {
    ...first,
    text,
    durationMs,
    visualKind: visualKindFor(text),
    sourceSectionId: parts.every((part) => part.sourceSectionId === first.sourceSectionId) ? first.sourceSectionId : null,
  };

  const cues = mapCues(structure.audioBindings, (current) => {
    const affected = current.filter((cue) => selected.has(cue.occurrenceId));
    if (affected.length === 0) return null;
    const combined: AudioCue = {
      occurrenceId: first.id,
      startMs: Math.min(...affected.map((cue) => cue.startMs)),
      endMs: Math.max(...affected.map((cue) => cue.endMs)),
    };
    const firstAffected = current.findIndex((cue) => selected.has(cue.occurrenceId));
    const rest = current.filter((cue) => !selected.has(cue.occurrenceId));
    return [...rest.slice(0, firstAffected), combined, ...rest.slice(firstAffected)];
  });
  if (cues.changed) review.push('cues-need-review');

  return done(structure, [...occurrences.slice(0, start), merged, ...occurrences.slice(start + indexes.length)], cues.bindings, review);
}

/**
 * Repete as ocorrências escolhidas logo depois da última delas. As cópias têm
 * IDs novos e começam com o mesmo texto e tempo; a partir daí são independentes.
 */
export function repeatOccurrences(structure: ArrangementStructure, ids: readonly Uuid[], newId: () => Uuid): EditResult {
  const occurrences = inOrder(structure.occurrences);
  const selected = new Set(ids);
  const sources = occurrences.filter((occurrence) => selected.has(occurrence.id));
  if (sources.length === 0 || sources.length !== selected.size) return { ok: false, error: 'unknown-occurrence' };
  if (occurrences.length + sources.length > MAX_OCCURRENCES) return { ok: false, error: 'occurrence-limit' };

  const copies = sources.map((source) => ({ ...source, id: newId() }));
  const insertAt = occurrences.findIndex((occurrence) => occurrence.id === sources.at(-1)?.id) + 1;
  return done(
    structure,
    [...occurrences.slice(0, insertAt), ...copies, ...occurrences.slice(insertAt)],
    structure.audioBindings,
    hasCues(structure) ? ['cues-need-review'] : [],
    copies.map((copy) => copy.id),
  );
}

/** Move uma ocorrência para a posição `toIndex` (0 = primeira). Os IDs não mudam. */
export function moveOccurrence(structure: ArrangementStructure, id: Uuid, toIndex: number): EditResult {
  const occurrences = inOrder(structure.occurrences);
  const from = occurrences.findIndex((occurrence) => occurrence.id === id);
  const moving = occurrences[from];
  if (!moving) return { ok: false, error: 'unknown-occurrence' };
  const target = Math.max(0, Math.min(occurrences.length - 1, Math.trunc(toIndex)));
  const rest = occurrences.filter((occurrence) => occurrence.id !== id);
  const reordered = [...rest.slice(0, target), moving, ...rest.slice(target)];

  const position = new Map(reordered.map((occurrence, index) => [occurrence.id, index]));
  const mismatch = structure.audioBindings.some((binding) => {
    const cuePositions = [...binding.cues].sort((a, b) => a.startMs - b.startMs).map((cue) => position.get(cue.occurrenceId) ?? -1);
    return cuePositions.some((value, index) => index > 0 && value < (cuePositions[index - 1] ?? -1));
  });
  return done(structure, reordered, structure.audioBindings, mismatch ? ['cue-order-mismatch'] : []);
}

export function removeOccurrences(structure: ArrangementStructure, ids: readonly Uuid[]): EditResult {
  const selected = new Set(ids);
  const occurrences = inOrder(structure.occurrences);
  if (selected.size === 0 || occurrences.filter((occurrence) => selected.has(occurrence.id)).length !== selected.size) {
    return { ok: false, error: 'unknown-occurrence' };
  }
  const cues = mapCues(structure.audioBindings, (current) =>
    current.some((cue) => selected.has(cue.occurrenceId)) ? current.filter((cue) => !selected.has(cue.occurrenceId)) : null,
  );
  return done(
    structure,
    occurrences.filter((occurrence) => !selected.has(occurrence.id)),
    cues.bindings,
    cues.changed ? ['cues-need-review'] : [],
  );
}

/**
 * Define ou remove (`null`) o tempo apenas das ocorrências indicadas. Outras
 * repetições do mesmo texto não são alteradas.
 */
export function setOccurrenceDuration(structure: ArrangementStructure, ids: readonly Uuid[], durationMs: number | null): EditResult {
  if (!isValidOccurrenceDuration(durationMs)) return { ok: false, error: 'invalid-duration' };
  const selected = new Set(ids);
  const occurrences = inOrder(structure.occurrences);
  if (selected.size === 0 || occurrences.filter((occurrence) => selected.has(occurrence.id)).length !== selected.size) {
    return { ok: false, error: 'unknown-occurrence' };
  }
  return done(
    structure,
    occurrences.map((occurrence) => (selected.has(occurrence.id) ? { ...occurrence, durationMs } : occurrence)),
    structure.audioBindings,
    hasCues(structure) ? ['cues-need-review'] : [],
  );
}

/**
 * Converte o campo de segundos (aceita vírgula ou ponto) em milissegundos
 * inteiros. Devolve `null` para texto inválido ou fora de 0,5–600 s; campo
 * vazio também é inválido — remover o tempo é uma ação própria.
 */
export function parseTimerSeconds(input: string): number | null {
  const text = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const durationMs = Math.round(Number(text) * 1000);
  return isValidOccurrenceDuration(durationMs) ? durationMs : null;
}

/** Texto do campo de segundos para uma duração: 8000 → "8", 500 → "0,5". */
export function formatTimerSeconds(durationMs: number): string {
  return String(durationMs / 1000).replace('.', ',');
}

/** Resultado dos botões −/+ a partir do texto atual do campo, dentro dos limites. */
export function stepTimerSeconds(input: string, direction: 1 | -1): string {
  const current = parseTimerSeconds(input) ?? TIMER_SUGGESTION_MS;
  const next = Math.min(OCCURRENCE_DURATION_MS.max, Math.max(OCCURRENCE_DURATION_MS.min, current + direction * TIMER_STEP_MS));
  return formatTimerSeconds(next);
}
