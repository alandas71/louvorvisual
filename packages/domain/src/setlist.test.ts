import { describe, expect, it } from 'vitest';
import { addSetlistItem, createSetlist, duplicatedSetlistItems, moveSetlistItem, orderedSetlistItems, removeSetlistItem } from './setlist';

function ids() {
  let next = 0;
  return () => `item-${++next}`;
}

describe('repertório ordenado', () => {
  it('cria vazio, sem servidor, com título aparado', () => {
    const setlist = createSetlist({ title: '  Culto de domingo ', serviceDate: '2026-10-11', timeZone: 'America/Sao_Paulo' }, { workspaceId: 'ws', userId: 'u', now: '2026-10-05T12:00:00.000Z', newId: ids() });
    expect(setlist).toMatchObject({ title: 'Culto de domingo', serviceDate: '2026-10-11', items: [], serverRevision: null, deletedAt: null });
  });

  it('acrescenta ao fim, permite repetir o arranjo e mantém IDs de item distintos', () => {
    const newId = ids();
    let items = addSetlistItem([], 'arr-a', newId);
    items = addSetlistItem(items, 'arr-b', newId);
    items = addSetlistItem(items, 'arr-a', newId);
    expect(items.map((item) => [item.id, item.arrangementId, item.order])).toEqual([
      ['item-1', 'arr-a', 0],
      ['item-2', 'arr-b', 1],
      ['item-3', 'arr-a', 2],
    ]);
    expect(duplicatedSetlistItems(items)).toEqual([]);
  });

  it('move e remove renumerando a ordem sem ambiguidade', () => {
    const newId = ids();
    let items = ['a', 'b', 'c', 'd'].reduce((list, id) => addSetlistItem(list, id, newId), [] as ReturnType<typeof addSetlistItem>);
    items = moveSetlistItem(items, 'item-4', 0);
    expect(orderedSetlistItems(items).map((item) => item.arrangementId)).toEqual(['d', 'a', 'b', 'c']);
    items = moveSetlistItem(items, 'item-1', 99);
    expect(orderedSetlistItems(items).map((item) => item.arrangementId)).toEqual(['d', 'b', 'c', 'a']);
    items = removeSetlistItem(items, 'item-2');
    expect(items.map((item) => [item.arrangementId, item.order])).toEqual([['d', 0], ['c', 1], ['a', 2]]);
    expect(moveSetlistItem(items, 'inexistente', 0).map((item) => item.arrangementId)).toEqual(['d', 'c', 'a']);
    expect(duplicatedSetlistItems(items)).toEqual([]);
  });
});
