import {
  FONT_SIZE_PX,
  FONT_WEIGHTS,
  isBundledFontId,
  isThemePresetId,
  isValidOccurrenceDuration,
  LINE_HEIGHT,
  TEXT_ALIGNS,
  themePreset,
  VERTICAL_ALIGNS,
  type BundledFontId,
  type FontWeight,
  type TextAlign,
  type ThemePresetId,
  type ThemeStyle,
  type Uuid,
  type VerticalAlign,
} from '@louvorvisual/domain';
import type { SessionSnapshot, SnapshotOccurrence } from './snapshot';

/** Ajuste vale para a ocorrência atual ou para todos os slides do louvor. */
export type AdjustScope = 'occurrence' | 'song';

/**
 * Ajustes visuais explícitos do operador. O tema é guardado pelo ID: fundo e
 * cor das letras sempre saem juntos do mesmo tema de fábrica.
 */
export type VisualPatch = {
  themePresetId?: ThemePresetId;
  fontId?: BundledFontId;
  fontSizePx?: number;
  fontWeight?: FontWeight;
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  lineHeight?: number;
};
export type VisualKey = keyof VisualPatch;
export const VISUAL_KEYS: readonly VisualKey[] = ['themePresetId', 'fontId', 'fontSizePx', 'fontWeight', 'textAlign', 'verticalAlign', 'lineHeight'];

export type OccurrenceOverride = {
  visual?: VisualPatch;
  text?: string;
  /** Ausente: vale o tempo preparado. `null`: tempo removido nesta sessão. */
  durationMs?: number | null;
};

/** Camada de ajustes da sessão; nunca substitui o snapshot preparado. */
export type SessionOverrides = {
  /** Geração: cresce a cada alteração aplicada, inclusive ao desfazer. */
  revision: number;
  song: VisualPatch;
  occurrences: Record<Uuid, OccurrenceOverride>;
};

/** Histórico curto de desfazer (planejamento/20). */
export const OVERRIDES_UNDO_LIMIT = 20;

export type OverridesState = {
  current: SessionOverrides;
  undo: SessionOverrides[];
};

export function emptyOverrides(): OverridesState {
  return { current: { revision: 0, song: {}, occurrences: {} }, undo: [] };
}

export type PatchIssue = 'unknown-theme' | 'unknown-font' | 'font-size-out-of-range' | 'invalid-value';

/** Confere um ajuste antes de aplicar; nada inválido entra na camada. */
export function visualPatchIssues(patch: VisualPatch): PatchIssue[] {
  const issues: PatchIssue[] = [];
  if (patch.themePresetId !== undefined && !isThemePresetId(patch.themePresetId)) issues.push('unknown-theme');
  if (patch.fontId !== undefined && !isBundledFontId(patch.fontId)) issues.push('unknown-font');
  if (patch.fontSizePx !== undefined) {
    const size = patch.fontSizePx;
    if (!Number.isInteger(size) || size < FONT_SIZE_PX.min || size > FONT_SIZE_PX.max) issues.push('font-size-out-of-range');
  }
  if (
    (patch.fontWeight !== undefined && !FONT_WEIGHTS.includes(patch.fontWeight)) ||
    (patch.textAlign !== undefined && !TEXT_ALIGNS.includes(patch.textAlign)) ||
    (patch.verticalAlign !== undefined && !VERTICAL_ALIGNS.includes(patch.verticalAlign)) ||
    (patch.lineHeight !== undefined && !(patch.lineHeight >= LINE_HEIGHT.min && patch.lineHeight <= LINE_HEIGHT.max))
  ) {
    issues.push('invalid-value');
  }
  return issues;
}

function commit(state: OverridesState, next: Omit<SessionOverrides, 'revision'>): OverridesState {
  return {
    current: { ...next, revision: state.current.revision + 1 },
    undo: [...state.undo, state.current].slice(-OVERRIDES_UNDO_LIMIT),
  };
}

function withOccurrence(current: SessionOverrides, occurrenceId: Uuid, change: (previous: OccurrenceOverride) => OccurrenceOverride) {
  const next = change(current.occurrences[occurrenceId] ?? {});
  const occurrences = { ...current.occurrences };
  const empty = next.text === undefined && next.durationMs === undefined && Object.keys(next.visual ?? {}).length === 0;
  if (empty) delete occurrences[occurrenceId];
  else occurrences[occurrenceId] = next;
  return occurrences;
}

/** Aplica um ajuste visual no escopo escolhido. Chaves fora do patch não mudam. */
export function applyVisual(state: OverridesState, scope: AdjustScope, occurrenceId: Uuid, patch: VisualPatch): OverridesState {
  const { current } = state;
  if (scope === 'song') {
    // Ajuste para o louvor inteiro substitui o que cada slide tinha nessas chaves.
    const occurrences: Record<Uuid, OccurrenceOverride> = {};
    for (const [id, override] of Object.entries(current.occurrences)) {
      const visual = { ...(override.visual ?? {}) };
      for (const key of Object.keys(patch) as VisualKey[]) delete visual[key];
      const next = { ...override, visual };
      if (next.text !== undefined || next.durationMs !== undefined || Object.keys(visual).length > 0) occurrences[id] = next;
    }
    return commit(state, { song: { ...current.song, ...patch }, occurrences });
  }
  return commit(state, {
    song: current.song,
    occurrences: withOccurrence(current, occurrenceId, (previous) => ({ ...previous, visual: { ...(previous.visual ?? {}), ...patch } })),
  });
}

/** Volta as chaves ao valor preparado no escopo escolhido. */
export function resetVisual(state: OverridesState, scope: AdjustScope, occurrenceId: Uuid, keys: readonly VisualKey[]): OverridesState {
  const { current } = state;
  const without = (patch: VisualPatch): VisualPatch => {
    const next = { ...patch };
    for (const key of keys) delete next[key];
    return next;
  };
  if (scope === 'song') {
    const occurrences: Record<Uuid, OccurrenceOverride> = {};
    for (const [id, override] of Object.entries(current.occurrences)) {
      const next = { ...override, visual: without(override.visual ?? {}) };
      if (next.text !== undefined || next.durationMs !== undefined || Object.keys(next.visual).length > 0) occurrences[id] = next;
    }
    return commit(state, { song: without(current.song), occurrences });
  }
  return commit(state, {
    song: current.song,
    occurrences: withOccurrence(current, occurrenceId, (previous) => ({ ...previous, visual: without(previous.visual ?? {}) })),
  });
}

export function applyText(state: OverridesState, occurrenceId: Uuid, text: string): OverridesState {
  return commit(state, {
    song: state.current.song,
    occurrences: withOccurrence(state.current, occurrenceId, (previous) => ({ ...previous, text })),
  });
}

/** `null` remove o tempo nesta sessão; nunca é tratado como zero. */
export function applyDuration(state: OverridesState, occurrenceId: Uuid, durationMs: number | null): OverridesState | null {
  if (!isValidOccurrenceDuration(durationMs)) return null;
  return commit(state, {
    song: state.current.song,
    occurrences: withOccurrence(state.current, occurrenceId, (previous) => ({ ...previous, durationMs })),
  });
}

/** Vários tempos em uma única alteração (um só passo de desfazer); `null` se algum for inválido. */
export function applyDurations(state: OverridesState, durations: Readonly<Record<Uuid, number | null>>): OverridesState | null {
  if (Object.values(durations).some((durationMs) => !isValidOccurrenceDuration(durationMs))) return null;
  let occurrences = state.current.occurrences;
  for (const [occurrenceId, durationMs] of Object.entries(durations)) {
    occurrences = withOccurrence({ ...state.current, occurrences }, occurrenceId, (previous) => ({ ...previous, durationMs }));
  }
  return commit(state, { song: state.current.song, occurrences });
}

export function canUndoOverrides(state: OverridesState): boolean {
  return state.undo.length > 0;
}

/** Desfaz o último ajuste. A geração continua crescendo: é uma nova alteração. */
export function undoOverrides(state: OverridesState): OverridesState {
  const previous = state.undo.at(-1);
  if (!previous) return state;
  return { current: { ...previous, revision: state.current.revision + 1 }, undo: state.undo.slice(0, -1) };
}

/** "Restaurar aparência preparada": remove todos os ajustes visuais; texto e tempo ficam. */
export function restoreAppearance(state: OverridesState): OverridesState {
  const occurrences: Record<Uuid, OccurrenceOverride> = {};
  for (const [id, override] of Object.entries(state.current.occurrences)) {
    if (override.text === undefined && override.durationMs === undefined) continue;
    const rest: OccurrenceOverride = {};
    if (override.text !== undefined) rest.text = override.text;
    if (override.durationMs !== undefined) rest.durationMs = override.durationMs;
    occurrences[id] = rest;
  }
  return commit(state, { song: {}, occurrences });
}

export function hasVisualOverrides(overrides: SessionOverrides): boolean {
  return Object.keys(overrides.song).length > 0 || Object.values(overrides.occurrences).some((item) => Object.keys(item.visual ?? {}).length > 0);
}

/** O que a saída desenha para uma ocorrência: base do snapshot + ajustes da sessão. */
export type ResolvedSlide = {
  occurrenceId: Uuid;
  label: string;
  text: string;
  durationMs: number | null;
  style: ThemeStyle;
  fontId: BundledFontId;
  /** Tema de fábrica cuja paleta está valendo; `null` quando a paleta veio de ajuste do arranjo. */
  themePresetId: ThemePresetId | null;
  fontChosen: boolean;
};

/**
 * Precedência (planejamento/20): ajuste da ocorrência → ajuste do louvor →
 * base preparada. Fonte manual vence a inicial do tema; sem fonte manual, a
 * inicial do tema em vigor.
 */
export function resolveSlide(snapshot: SessionSnapshot, overrides: SessionOverrides, occurrence: SnapshotOccurrence): ResolvedSlide {
  const own = overrides.occurrences[occurrence.id];
  const patch: VisualPatch = { ...overrides.song, ...(own?.visual ?? {}) };
  const sessionTheme = patch.themePresetId;
  const basePreset = themePreset(snapshot.themePresetId);
  const baseIsPreset =
    occurrence.style.palette.backgroundColor === basePreset.style.palette.backgroundColor &&
    occurrence.style.palette.textColor === basePreset.style.palette.textColor;
  const themePresetId = sessionTheme ?? (baseIsPreset ? snapshot.themePresetId : null);
  const fontChosen = patch.fontId !== undefined || snapshot.fontChosen;
  const style: ThemeStyle = {
    ...occurrence.style,
    palette: sessionTheme ? { ...themePreset(sessionTheme).style.palette } : occurrence.style.palette,
    fontSizePx: patch.fontSizePx ?? occurrence.style.fontSizePx,
    fontWeight: patch.fontWeight ?? occurrence.style.fontWeight,
    textAlign: patch.textAlign ?? occurrence.style.textAlign,
    verticalAlign: patch.verticalAlign ?? occurrence.style.verticalAlign,
    lineHeight: patch.lineHeight ?? occurrence.style.lineHeight,
  };
  return {
    occurrenceId: occurrence.id,
    label: occurrence.label,
    text: own?.text ?? occurrence.text,
    durationMs: own?.durationMs !== undefined ? own.durationMs : occurrence.durationMs,
    style,
    fontId: patch.fontId ?? (snapshot.fontChosen ? snapshot.fontId : themePreset(sessionTheme ?? snapshot.themePresetId).initialFontId),
    themePresetId,
    fontChosen,
  };
}

/** Próximo tamanho de A−/A+ a partir do tamanho em vigor; `null` no limite. */
export function steppedFontSize(currentPx: number, direction: 1 | -1): number | null {
  const next = Math.min(FONT_SIZE_PX.max, Math.max(FONT_SIZE_PX.min, currentPx + direction * FONT_SIZE_PX.step));
  return next === currentPx ? null : next;
}
