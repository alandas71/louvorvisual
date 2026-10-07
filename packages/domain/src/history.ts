/** Operações guardadas para desfazer na edição atual. */
export const HISTORY_LIMIT = 100;

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Identifica uma sequência de pequenas alterações que conta como uma operação (ex.: digitação). */
  coalesceKey: string | null;
};

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], coalesceKey: null };
}

/**
 * Registra um novo estado. Com a mesma `coalesceKey` do registro anterior, só
 * substitui o estado atual: digitar uma frase é desfeito de uma vez.
 */
export function pushHistory<T>(history: History<T>, next: T, coalesceKey: string | null = null): History<T> {
  if (coalesceKey !== null && history.coalesceKey === coalesceKey) {
    return { ...history, present: next, future: [] };
  }
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [], coalesceKey };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], coalesceKey: null };
}

export function redoHistory<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest, coalesceKey: null };
}
