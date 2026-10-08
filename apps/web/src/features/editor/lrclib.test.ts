import { describe, expect, it } from 'vitest';
import { lyricsFromLrclib, parseSyncedLyrics, rankLrclibTracks, type LrclibTrack } from './lrclib';

const track = (overrides: Partial<LrclibTrack>): LrclibTrack => ({
  id: 1,
  trackName: 'Canção',
  artistName: 'Artista',
  albumName: null,
  duration: 180,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: null,
  ...overrides,
});

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

  it('prioriza sugestões mesmo com acento, pontuação ou grafia não idêntica', () => {
    const results = rankLrclibTracks(
      [track({ id: 1, trackName: 'Outra Canção', artistName: 'Outro' }), track({ id: 2, trackName: 'Ousado Amor!', artistName: 'Isaias Saad' })],
      'ousado amor',
      'Isaías Saad',
    );
    expect(results.map((item) => item.id)).toEqual([2, 1]);
  });

  it('prefere a letra simples e usa a sincronizada como alternativa', () => {
    expect(lyricsFromLrclib(track({ plainLyrics: 'Verso\nRefrão', syncedLyrics: '[00:01]Outro verso' }))).toBe('Verso\nRefrão');
    expect(lyricsFromLrclib(track({ syncedLyrics: '[00:01]Verso\n[00:03]Refrão' }))).toBe('Verso\nRefrão');
  });
});
