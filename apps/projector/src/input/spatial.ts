export type Direction = 'up' | 'down' | 'left' | 'right';
export type Box = { left: number; top: number; right: number; bottom: number };

type Axis = { start: (box: Box) => number; end: (box: Box) => number };
const X: Axis = { start: (box) => box.left, end: (box) => box.right };
const Y: Axis = { start: (box) => box.top, end: (box) => box.bottom };

/** Distância entre dois intervalos; zero quando se sobrepõem. */
function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, bStart - aEnd, aStart - bEnd);
}

/**
 * Próximo alvo de foco na direção pedida. Só entram candidatos que começam
 * depois da borda do elemento atual naquela direção (com folga para elementos
 * encostados); entre eles vence o mais próximo, e desalinhamento pesa o dobro
 * — de um botão, a seta leva ao vizinho da mesma linha ou coluna antes de um
 * mais perto na diagonal. Sem candidato, o foco fica onde está.
 */
export function pickNext<T extends { box: Box }>(from: Box, candidates: readonly T[], direction: Direction): T | null {
  const horizontal = direction === 'left' || direction === 'right';
  const main = horizontal ? X : Y;
  const cross = horizontal ? Y : X;
  const forward = direction === 'right' || direction === 'down';
  const tolerance = Math.min(8, (main.end(from) - main.start(from)) / 4);
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const { box } = candidate;
    const distance = forward ? main.start(box) - main.end(from) : main.start(from) - main.end(box);
    if (distance < -tolerance) continue;
    const score = Math.max(0, distance) + 2 * gap(cross.start(from), cross.end(from), cross.start(box), cross.end(box));
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

const center = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

/** Candidato mais próximo de onde o foco estava; usado quando o elemento focado some. */
export function pickNearest<T extends { box: Box }>(from: Box, candidates: readonly T[]): T | null {
  const origin = center(from);
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const point = center(candidate.box);
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
