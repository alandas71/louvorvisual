import type { Arrangement, OccurrenceVisualOverrides, ThemeOverrides, ThemeRef, Uuid } from '@louvorvisual/domain';
import { themePreset } from '@louvorvisual/domain';
import type { SessionOverrides, VisualPatch } from './overrides';

/** Campo que a sessão ajustou e o que aconteceu com ele ao salvar no arranjo. */
export type SaveField = {
  target: 'arrangement' | Uuid;
  field: 'theme' | 'font' | 'fontSizePx' | 'fontWeight' | 'textAlign' | 'verticalAlign' | 'lineHeight' | 'text' | 'durationMs' | 'defaultMode';
};

export type SaveToArrangementResult = {
  arrangement: Arrangement;
  applied: SaveField[];
  /** O arranjo mudou nesse campo depois da preparação; a versão da biblioteca foi mantida. */
  conflicts: SaveField[];
  /** Ajuste que o arranjo não tem onde guardar (ex.: fonte de um único slide) ou slide que não existe mais. */
  skipped: SaveField[];
  changed: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * "Salvar ajustes no arranjo": leva para o documento atual só os campos que a
 * sessão alterou, comparando cada um com o arranjo como estava na preparação (`base`). Campo que
 * outra edição mudou nesse meio-tempo vira conflito e não é sobrescrito.
 * Rotação da saída nunca é gravada no arranjo.
 */
export function mergeOverridesIntoArrangement(
  base: Arrangement,
  overrides: SessionOverrides,
  current: Arrangement,
  options: { setDefaultModeAutomatic?: boolean } = {},
): SaveToArrangementResult {
  const applied: SaveField[] = [];
  const conflicts: SaveField[] = [];
  const skipped: SaveField[] = [];
  let themeRef: ThemeRef = current.themeRef;
  let themeOverrides: ThemeOverrides = { ...(current.themeOverrides ?? {}) };
  let fontId = current.fontId;
  let defaultMode = current.defaultMode;

  if (options.setDefaultModeAutomatic) {
    const field: SaveField = { target: 'arrangement', field: 'defaultMode' };
    if (current.defaultMode === base.defaultMode) {
      defaultMode = 'automatic';
      if (current.defaultMode !== defaultMode) applied.push(field);
    } else conflicts.push(field);
  }

  const song = overrides.song;
  if (song.themePresetId !== undefined) {
    const field: SaveField = { target: 'arrangement', field: 'theme' };
    if (same(current.themeRef, base.themeRef) && same(current.themeOverrides?.palette, base.themeOverrides?.palette)) {
      themeRef = { kind: 'builtin', presetId: song.themePresetId };
      // A paleta é uma unidade: não sobra ajuste de cor do tema anterior.
      themeOverrides = Object.fromEntries(Object.entries(themeOverrides).filter(([key]) => key !== 'palette'));
      applied.push(field);
    } else conflicts.push(field);
  }
  if (song.fontId !== undefined) {
    const field: SaveField = { target: 'arrangement', field: 'font' };
    if (current.fontId === base.fontId) {
      fontId = song.fontId;
      applied.push(field);
    } else conflicts.push(field);
  }
  for (const key of ['fontSizePx', 'fontWeight', 'textAlign', 'verticalAlign', 'lineHeight'] as const) {
    const value = song[key];
    if (value === undefined) continue;
    const field: SaveField = { target: 'arrangement', field: key };
    if (same(current.themeOverrides?.[key], base.themeOverrides?.[key])) {
      themeOverrides = { ...themeOverrides, [key]: value };
      applied.push(field);
    } else conflicts.push(field);
  }

  const baseById = new Map(base.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const linked = current.audioBindings.some((binding) => binding.policy === 'linked');
  const occurrences = current.occurrences.map((occurrence) => {
    const override = overrides.occurrences[occurrence.id];
    const before = baseById.get(occurrence.id);
    if (!override || !before) return occurrence;
    let next = occurrence;
    if (override.text !== undefined) {
      const field: SaveField = { target: occurrence.id, field: 'text' };
      if (occurrence.text === before.text) {
        next = { ...next, text: override.text };
        applied.push(field);
      } else conflicts.push(field);
    }
    if (override.durationMs !== undefined) {
      const field: SaveField = { target: occurrence.id, field: 'durationMs' };
      // Com faixa vinculada, tempo e marcações são revistos no editor, não aqui.
      if (linked) skipped.push(field);
      else if (occurrence.durationMs === before.durationMs) {
        next = { ...next, durationMs: override.durationMs };
        applied.push(field);
      } else conflicts.push(field);
    }
    const visual: VisualPatch = override.visual ?? {};
    let own: OccurrenceVisualOverrides = { ...(next.visualOverrides ?? {}) };
    let ownChanged = false;
    if (visual.themePresetId !== undefined) {
      const field: SaveField = { target: occurrence.id, field: 'theme' };
      if (same(occurrence.visualOverrides?.palette, before.visualOverrides?.palette)) {
        own = { ...own, palette: { ...themePreset(visual.themePresetId).style.palette } };
        ownChanged = true;
        applied.push(field);
      } else conflicts.push(field);
    }
    for (const key of ['fontSizePx', 'fontWeight', 'textAlign', 'verticalAlign'] as const) {
      const value = visual[key];
      if (value === undefined) continue;
      const field: SaveField = { target: occurrence.id, field: key };
      if (same(occurrence.visualOverrides?.[key], before.visualOverrides?.[key])) {
        own = { ...own, [key]: value };
        ownChanged = true;
        applied.push(field);
      } else conflicts.push(field);
    }
    // O documento do arranjo não guarda fonte nem entrelinha por slide.
    if (visual.fontId !== undefined) skipped.push({ target: occurrence.id, field: 'font' });
    if (visual.lineHeight !== undefined) skipped.push({ target: occurrence.id, field: 'lineHeight' });
    return ownChanged ? { ...next, visualOverrides: own } : next;
  });

  const known = new Set(current.occurrences.map((occurrence) => occurrence.id));
  for (const [id, override] of Object.entries(overrides.occurrences)) {
    if (known.has(id) && baseById.has(id)) continue;
    if (override.text !== undefined) skipped.push({ target: id, field: 'text' });
    if (override.durationMs !== undefined) skipped.push({ target: id, field: 'durationMs' });
    if (Object.keys(override.visual ?? {}).length > 0) skipped.push({ target: id, field: 'theme' });
  }

  const changed = applied.length > 0;
  return {
    arrangement: changed
      ? { ...current, themeRef, themeOverrides: Object.keys(themeOverrides).length > 0 ? themeOverrides : null, fontId, defaultMode, occurrences }
      : current,
    applied,
    conflicts,
    skipped,
    changed,
  };
}
