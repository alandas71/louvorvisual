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

export type TimedLyricLine = { startMs: number; text: string };

const LRC_TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Ignora tags de metadados e expande linhas que tenham mais de uma marcação. */
export function parseSyncedLyrics(source: string): TimedLyricLine[] {
  const lines: TimedLyricLine[] = [];
  for (const sourceLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const times: number[] = [];
    for (const match of sourceLine.matchAll(LRC_TIME)) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) * 1000 : 0;
      if (Number.isFinite(minutes) && Number.isFinite(seconds) && seconds < 60) times.push(Math.round((minutes * 60 + seconds) * 1000 + fraction));
    }
    const text = sourceLine.replace(LRC_TIME, '').trim();
    if (times.length === 0 || text === '') continue;
    for (const startMs of times) lines.push({ startMs, text });
  }
  return lines.sort((a, b) => a.startMs - b.startMs);
}

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
