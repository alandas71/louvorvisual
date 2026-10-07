import { SCHEMA_VERSION, type AggregateMeta, type CivilDate, type Uuid } from './common';
import type { ThemeRef } from './theme';

/** Item próprio do repertório; repetir o mesmo arranjo é permitido. */
export type SetlistItem = {
  id: Uuid;
  arrangementId: Uuid;
  order: number;
  notes: string;
};

export type Setlist = AggregateMeta & {
  id: Uuid;
  title: string;
  serviceDate: CivilDate | null;
  /** Fuso IANA associado ao culto (ex.: America/Sao_Paulo). */
  timeZone: string;
  themeRef: ThemeRef | null;
  notes: string;
  items: SetlistItem[];
};

/** Índices dos itens cujo ID ou ordem repete um item anterior. */
export function duplicatedSetlistItems(items: SetlistItem[]): { index: number; field: 'id' | 'order' }[] {
  const ids = new Set<Uuid>();
  const orders = new Set<number>();
  const duplicated: { index: number; field: 'id' | 'order' }[] = [];
  items.forEach((item, index) => {
    if (ids.has(item.id)) duplicated.push({ index, field: 'id' });
    ids.add(item.id);
    if (orders.has(item.order)) duplicated.push({ index, field: 'order' });
    orders.add(item.order);
  });
  return duplicated;
}

export type SetlistInput = { title: string; serviceDate?: CivilDate | null; timeZone: string; notes?: string };

/** Contexto de autoria mínimo; declarado aqui para não criar ciclo com `authoring`. */
type SetlistContext = { workspaceId: Uuid; userId: Uuid; now: string; newId: () => Uuid };

export function createSetlist(input: SetlistInput, context: SetlistContext): Setlist {
  return {
    workspaceId: context.workspaceId,
    schemaVersion: SCHEMA_VERSION,
    serverRevision: null,
    createdBy: context.userId,
    updatedBy: context.userId,
    createdAt: context.now,
    updatedAt: context.now,
    deletedAt: null,
    id: context.newId(),
    title: input.title.trim(),
    serviceDate: input.serviceDate ?? null,
    timeZone: input.timeZone,
    themeRef: null,
    notes: input.notes ?? '',
    items: [],
  };
}

/** Itens na ordem de apresentação. */
export function orderedSetlistItems(items: readonly SetlistItem[]): SetlistItem[] {
  return [...items].sort((a, b) => a.order - b.order);
}

const renumbered = (items: readonly SetlistItem[]): SetlistItem[] => items.map((item, order) => (item.order === order ? item : { ...item, order }));

/** Acrescenta um arranjo ao fim; o mesmo arranjo pode aparecer mais de uma vez, cada vez com item próprio. */
export function addSetlistItem(items: readonly SetlistItem[], arrangementId: Uuid, newId: () => Uuid): SetlistItem[] {
  return renumbered([...orderedSetlistItems(items), { id: newId(), arrangementId, order: items.length, notes: '' }]);
}

export function removeSetlistItem(items: readonly SetlistItem[], itemId: Uuid): SetlistItem[] {
  return renumbered(orderedSetlistItems(items).filter((item) => item.id !== itemId));
}

/** Move um item para a posição indicada; posição fora da lista é limitada às pontas. */
export function moveSetlistItem(items: readonly SetlistItem[], itemId: Uuid, toIndex: number): SetlistItem[] {
  const ordered = orderedSetlistItems(items);
  const from = ordered.findIndex((item) => item.id === itemId);
  if (from < 0) return ordered;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, moved as SetlistItem);
  return renumbered(ordered);
}
