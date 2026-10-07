import { describe, expect, it } from 'vitest';
import { pickNearest, pickNext, type Box } from './spatial';

const box = (left: number, top: number, width = 100, height = 60): Box => ({ left, top, right: left + width, bottom: top + height });
const item = (id: string, left: number, top: number, width?: number, height?: number) => ({ id, box: box(left, top, width, height) });

describe('navegação direcional', () => {
  // Grade 2 × 2 como a dos cartões da tela inicial.
  const grid = [item('a', 0, 0), item('b', 120, 0), item('c', 0, 80), item('d', 120, 80)];
  const others = (id: string) => grid.filter((entry) => entry.id !== id);

  it('grade: cada seta leva ao vizinho da mesma linha ou coluna', () => {
    expect(pickNext(grid[0]!.box, others('a'), 'right')?.id).toBe('b');
    expect(pickNext(grid[0]!.box, others('a'), 'down')?.id).toBe('c');
    expect(pickNext(grid[3]!.box, others('d'), 'left')?.id).toBe('c');
    expect(pickNext(grid[3]!.box, others('d'), 'up')?.id).toBe('b');
  });

  it('na borda não há para onde ir: o foco fica', () => {
    expect(pickNext(grid[0]!.box, others('a'), 'left')).toBeNull();
    expect(pickNext(grid[0]!.box, others('a'), 'up')).toBeNull();
    expect(pickNext(grid[3]!.box, others('d'), 'right')).toBeNull();
    expect(pickNext(grid[3]!.box, others('d'), 'down')).toBeNull();
  });

  it('lista vertical: esquerda e direita não saltam para outro item', () => {
    const list = [item('1', 0, 0, 400), item('2', 0, 70, 400), item('3', 0, 140, 400)];
    expect(pickNext(list[1]!.box, [list[0]!, list[2]!], 'right')).toBeNull();
    expect(pickNext(list[1]!.box, [list[0]!, list[2]!], 'left')).toBeNull();
    expect(pickNext(list[1]!.box, [list[0]!, list[2]!], 'down')?.id).toBe('3');
    expect(pickNext(list[1]!.box, [list[0]!, list[2]!], 'up')?.id).toBe('1');
  });

  it('controles nos cantos: sobe e desce pela mesma lateral, mesmo com outro botão mais perto na diagonal', () => {
    const corners = [item('menu', 20, 20, 64, 64), item('girar', 1836, 20, 64, 64), item('anterior', 20, 996, 64, 64), item('menor', 1600, 996, 64, 64), item('proximo', 1836, 996, 64, 64)];
    const from = (id: string) => corners.find((entry) => entry.id === id)!;
    const rest = (id: string) => corners.filter((entry) => entry.id !== id);
    expect(pickNext(from('proximo').box, rest('proximo'), 'up')?.id).toBe('girar');
    expect(pickNext(from('menu').box, rest('menu'), 'down')?.id).toBe('anterior');
    expect(pickNext(from('menu').box, rest('menu'), 'right')?.id).toBe('girar');
    expect(pickNext(from('proximo').box, rest('proximo'), 'left')?.id).toBe('menor');
    expect(pickNext(from('anterior').box, rest('anterior'), 'right')?.id).toBe('menor');
  });

  it('elemento que some: o foco vai para o mais próximo de onde estava', () => {
    const row = [item('menor', 1500, 996, 64, 64), item('maior', 1580, 996, 64, 64), item('proximo', 1740, 996, 64, 64)];
    const gone = box(1660, 996, 64, 64);
    expect(pickNearest(gone, row)?.id).toMatch(/maior|proximo/);
    expect(pickNearest(gone, [row[0]!])?.id).toBe('menor');
    expect(pickNearest(gone, [])).toBeNull();
  });
});
