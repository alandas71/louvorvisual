import { normalizeForComparison, parseSyncedLyrics } from '@louvorvisual/domain';

/** Cliente mínimo da API pública LRCLIB e leitor de timestamps LRC por linha. */
export type LrclibTrack = {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

export { parseSyncedLyrics, type TimedLyricLine } from '@louvorvisual/domain';

function words(value: string) {
  return normalizeForComparison(value).split(' ').filter(Boolean);
}

/**
 * Ordena as respostas da LRCLIB sem exigir grafia idêntica. A API já procura
 * candidatos; esta etapa favorece os que compartilham palavras do título e do
 * artista, ignorando caixa, acentos e pontuação.
 */
export function rankLrclibTracks(tracks: readonly LrclibTrack[], trackName: string, artistName?: string | null): LrclibTrack[] {
  const wantedTitle = normalizeForComparison(trackName);
  const wantedArtist = normalizeForComparison(artistName ?? '');
  const titleWords = words(trackName);
  const artistWords = words(artistName ?? '');
  const score = (track: LrclibTrack) => {
    const title = normalizeForComparison(track.trackName);
    const artist = normalizeForComparison(track.artistName);
    const overlap = (needles: readonly string[], haystack: string) => needles.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
    return (title === wantedTitle ? 100 : title.includes(wantedTitle) || wantedTitle.includes(title) ? 45 : 0)
      + overlap(titleWords, title) * 12
      + (wantedArtist !== '' && artist === wantedArtist ? 50 : 0)
      + overlap(artistWords, artist) * 10
      + (track.syncedLyrics || track.plainLyrics ? 2 : 0);
  };
  return [...tracks].sort((a, b) => score(b) - score(a) || a.trackName.localeCompare(b.trackName, 'pt-BR'));
}

export function lyricsFromLrclib(track: Pick<LrclibTrack, 'plainLyrics' | 'syncedLyrics'>): string | null {
  if (track.plainLyrics?.trim()) return track.plainLyrics.trim();
  const lines = track.syncedLyrics ? parseSyncedLyrics(track.syncedLyrics) : [];
  return lines.length > 0 ? lines.map((line) => line.text).join('\n') : null;
}

export async function searchLrclib(trackName: string, artistName?: string | null, signal?: AbortSignal): Promise<LrclibTrack[]> {
  const search = async (includeArtist: boolean) => {
    const params = new URLSearchParams({ track_name: trackName.trim() });
    if (includeArtist && artistName?.trim()) params.set('artist_name', artistName.trim());
    const response = await fetch(`https://lrclib.net/api/search?${params}`, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(response.status === 429 ? 'A LRCLIB pediu para aguardar antes de uma nova busca.' : 'Não foi possível consultar a LRCLIB agora.');
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data.filter(isTrack) as LrclibTrack[]) : [];
  };

  let tracks = await search(Boolean(artistName?.trim()));
  // Se o artista tiver sido digitado com outra grafia, o título ainda pode
  // encontrar a música. A ordenação abaixo continua levando o artista em conta.
  if (tracks.length === 0 && artistName?.trim()) tracks = await search(false);
  return rankLrclibTracks(tracks, trackName, artistName);
}

function isTrack(value: unknown): value is LrclibTrack {
  return Boolean(value && typeof value === 'object' && typeof (value as LrclibTrack).id === 'number' && typeof (value as LrclibTrack).trackName === 'string' && typeof (value as LrclibTrack).artistName === 'string');
}
