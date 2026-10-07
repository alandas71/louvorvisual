import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('une classes e ignora valores falsos', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
  });

  it('a última classe conflitante do Tailwind prevalece', () => {
    expect(cn('px-4 py-2', 'px-2')).toBe('py-2 px-2');
  });
});
