import { describe, expect, it } from 'vitest';
import { parseSyncedLyrics } from './lrclib';

describe('letra sincronizada da LRCLIB', () => {
  it('lê marcações LRC, inclusive mais de uma por verso, e ignora metadados', () => {
    expect(
      parseSyncedLyrics('[ar:Artista]\n[00:01.50]Primeiro verso\n[00:04.00][00:08.25]Refrão'),
    ).toEqual([
      { startMs: 1500, text: 'Primeiro verso' },
      { startMs: 4000, text: 'Refrão' },
      { startMs: 8250, text: 'Refrão' },
    ]);
  });
});
