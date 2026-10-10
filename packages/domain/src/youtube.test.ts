import { describe, expect, it } from 'vitest';
import { arrangementIssues } from './arrangement';
import { deriveCues } from './cues';
import { normalizeYoutubeUrl, parseSyncedLyrics, selectYoutubeLyrics, timedYoutubeSlides } from './youtube';

const id = 'abcdefghijk';
const track = { id: 1, trackName: 'Graça e Paz', artistName: 'Artista', duration: 180, instrumental: false, syncedLyrics: '[00:12.00]Verso\n[01:20.00]Refrão' };
describe('importação do YouTube', () => {
  it.each(['https://youtu.be/' + id + '?si=abc', 'https://www.youtube.com/watch?v=' + id + '&list=xyz', 'https://m.youtube.com/shorts/' + id, 'https://music.youtube.com/watch?v=' + id])('normaliza um único vídeo: %s', value => {
    expect(normalizeYoutubeUrl(value)).toBe('https://www.youtube.com/watch?v=' + id);
  });
  it.each(['https://youtube.com.evil.test/watch?v=' + id, 'https://youtube.com@evil.test/watch?v=' + id, 'file:///watch?v=' + id, 'https://www.youtube.com/playlist?list=x', 'https://youtu.be/short', 'https://www.youtube.com:8080/watch?v=' + id])('recusa URL inadequada: %s', value => expect(normalizeYoutubeUrl(value)).toBeNull());
  it('escolhe a versão mais próxima da duração e rejeita outra música ou artista', () => {
    const best = { ...track, id: 2, duration: 182 };
    expect(selectYoutubeLyrics([track, best, { ...track, id: 3, trackName: 'Outra música', duration: 182 }, { ...best, id: 4, artistName: 'Outra pessoa' }], 'Graça e Paz', 'Artista', 182000)).toEqual(best);
    expect(selectYoutubeLyrics([{ ...track, duration: 240 }, { ...track, syncedLyrics: null }, { ...track, instrumental: true }], track.trackName, track.artistName, 180000)).toBeNull();
  });
  it('preserva a introdução e produz intervalos até o fim do áudio', () => {
    let counter = 0;
    const occurrences = timedYoutubeSlides(parseSyncedLyrics(track.syncedLyrics), 180000, () => String(++counter))!;
    expect(occurrences.map(o => [o.text, o.durationMs, o.visualKind])).toEqual([['', 12000, 'instrumental'], ['Verso', 68000, 'lyrics'], ['Refrão', 100000, 'lyrics']]);
    const cues = deriveCues(occurrences, 0)!;
    expect(cues.map(c => [c.startMs,c.endMs])).toEqual([[0,12000],[12000,80000],[80000,180000]]);
    expect(arrangementIssues({ occurrences, selectedAudioBindingId: 'binding', audioBindings: [{ id: 'binding', assetId: 'asset', kind: 'original', policy: 'linked', volume: 1, offsetMs: 0, cuesVersion: 1, cues }] })).toEqual([]);
  });
  it('agrupa versos simultâneos e não inventa tempos para intervalos inválidos', () => {
    expect(timedYoutubeSlides([{ startMs: 0, text: 'A' }, { startMs: 0, text: 'B' }], 1000, () => 'id')?.[0]?.text).toBe('A\nB');
    expect(timedYoutubeSlides([{ startMs: 100, text: 'A' }], 1000, () => 'id')).toBeNull();
    expect(timedYoutubeSlides([{ startMs: 1000, text: 'A' }], 1000, () => 'id')).toBeNull();
    expect(timedYoutubeSlides([], 1000, () => 'id')).toBeNull();
  });
});
