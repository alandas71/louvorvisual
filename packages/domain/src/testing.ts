import type { Uuid } from './common';

/** IDs previsíveis para testes: `prefixo-1`, `prefixo-2`, … */
export function sequentialIds(prefix = 'id'): () => Uuid {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
