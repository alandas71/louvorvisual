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

export async function searchLrclib(trackName: string, artistName?: string | null): Promise<LrclibTrack[]> {
  const params = new URLSearchParams({ track_name: trackName.trim() });
  if (artistName?.trim()) params.set('artist_name', artistName.trim());
  const response = await fetch(`https://lrclib.net/api/search?${params}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 429 ? 'A LRCLIB pediu para aguardar antes de uma nova busca.' : 'Não foi possível consultar a LRCLIB agora.');
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data.filter(isTrack) as LrclibTrack[]) : [];
}

function isTrack(value: unknown): value is LrclibTrack {
  return Boolean(value && typeof value === 'object' && typeof (value as LrclibTrack).id === 'number' && typeof (value as LrclibTrack).trackName === 'string' && typeof (value as LrclibTrack).artistName === 'string');
}
