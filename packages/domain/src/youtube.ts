import { OCCURRENCE_DURATION_MS, type SlideOccurrence } from './arrangement';

export function normalizeYoutubeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const id = host === 'youtu.be' ? url.pathname.slice(1) :
      ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host) ?
        (url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)$/.exec(url.pathname)?.[1]) : null;
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? 'https://www.youtube.com/watch?v=' + id : null;
  } catch { return null; }
}

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


export type LyricsCandidate = { id: number; trackName: string; artistName: string; duration: number; syncedLyrics: string | null; instrumental: boolean };
const normalized = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const similarity = (a: string, b: string) => {
  const words = new Set(normalized(a).split(' ').filter(Boolean));
  const other = new Set(normalized(b).split(' ').filter(Boolean));
  const shared = [...words].filter(word => other.has(word)).length;
  return shared / Math.max(words.size, other.size, 1);
};

/** Só aceita letra com timestamps utilizáveis e duração próxima da gravação. */
export function selectYoutubeLyrics<T extends LyricsCandidate>(tracks: readonly T[], title: string, artist: string, durationMs: number): T | null {
  const eligible = tracks.filter(track => {
    if (track.instrumental || !track.syncedLyrics || !Number.isFinite(track.duration) || track.duration <= 0) return false;
    if (Math.abs(track.duration * 1000 - durationMs) > Math.max(5000, durationMs * 0.03)) return false;
    if (similarity(track.trackName, title) < 0.5 || (artist && similarity(track.artistName, artist) < 0.4)) return false;
    return timedYoutubeSlides(parseSyncedLyrics(track.syncedLyrics), durationMs, () => '') !== null;
  });
  return eligible.sort((a, b) =>
    (Math.abs(a.duration * 1000 - durationMs) - Math.abs(b.duration * 1000 - durationMs)) ||
    (similarity(b.trackName, title) - similarity(a.trackName, title)) || a.id - b.id)[0] ?? null;
}

/** Preserva o silêncio inicial e timestamps absolutos, sem esticar a letra para caber. */
export function timedYoutubeSlides(lines: readonly TimedLyricLine[], durationMs: number, newId: () => string): SlideOccurrence[] | null {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || lines.length === 0) return null;
  const grouped: TimedLyricLine[] = [];
  for (const line of [...lines].sort((a,b) => a.startMs - b.startMs)) {
    if (!Number.isSafeInteger(line.startMs) || line.startMs < 0 || line.startMs >= durationMs) return null;
    const previous = grouped.at(-1);
    if (previous?.startMs === line.startMs) previous.text += '\n' + line.text;
    else grouped.push({ ...line });
  }
  if (grouped[0]!.startMs > 0) grouped.unshift({ startMs: 0, text: '' });
  const slides: SlideOccurrence[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const line = grouped[i]!;
    const duration = (grouped[i + 1]?.startMs ?? durationMs) - line.startMs;
    if (duration < OCCURRENCE_DURATION_MS.min || duration > OCCURRENCE_DURATION_MS.max) return null;
    slides.push({ id: newId(), sourceSectionId: null, label: line.text ? 'Letra sincronizada' : 'Introdução', text: line.text, order: i,
      durationMs: duration, visualKind: line.text ? 'lyrics' : 'instrumental', visualOverrides: null });
  }
  return slides;
}
