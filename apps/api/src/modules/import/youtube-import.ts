import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_ASSET_BYTES, MAX_LYRICS_CHARS, normalizeYoutubeUrl, parseSyncedLyrics, selectYoutubeLyrics, type LyricsCandidate } from '@louvorvisual/domain';
import { AppError } from '../../utils/AppError';

const execute = promisify(execFile);
export type YoutubeImport = {
  title: string; artist: string; sourceUrl: string; durationMs: number;
  rawLyrics: string; syncedLyrics: string; lyricsId: number; audio: Buffer;
};
export type YoutubeImporter = (url: string, signal: AbortSignal) => Promise<YoutubeImport>;
type Metadata = { title?: string; track?: string; artist?: string; creator?: string; uploader?: string; duration?: number; is_live?: boolean };

export function youtubeSongMetadata(info: Metadata): { title: string; artist: string } {
  const clean = (s: string) => s.replace(/\s*[([](?:official[^)\]]*|vídeo[^)\]]*|video[^)\]]*|lyric[^)\]]*|clipe[^)\]]*)[)\]]/gi, '').trim();
  const parts = clean(info.title ?? '').split(/\s+[-–—|]\s+/);
  return { title: (info.track || (parts.length === 2 ? parts[1] : parts.join(' - ')) || '').trim(),
    artist: (info.artist || info.creator || (parts.length === 2 ? parts[0] : '') || '').trim() };
}

async function lookup(title: string, artist: string, signal: AbortSignal): Promise<LyricsCandidate[]> {
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  const response = await fetch('https://lrclib.net/api/search?' + params, { signal, headers: { Accept: 'application/json', 'User-Agent': 'LouvorVisual/0.1.0' } });
  if (!response.ok) throw new AppError(502, 'DEPENDENCY_NOT_READY', 'Não foi possível buscar a letra na LRCLIB. Tente novamente.');
  const data: unknown = await response.json();
  return Array.isArray(data) ? data.filter((value): value is LyricsCandidate =>
    value && typeof value.id === 'number' && typeof value.trackName === 'string' && typeof value.artistName === 'string' &&
    typeof value.duration === 'number' && typeof value.syncedLyrics === 'string' && value.syncedLyrics.length <= MAX_LYRICS_CHARS) : [];
}

/** Um diretório temporário exclusivo; nenhum título ou URL é interpolado em shell. */
export const importYoutube: YoutubeImporter = async (value, callerSignal) => {
  const url = normalizeYoutubeUrl(value);
  if (!url) throw new AppError(400, 'VALIDATION_ERROR', 'Informe a URL de um vídeo do YouTube.');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10 * 60_000)]);
  const directory = await mkdtemp(join(tmpdir(), 'louvorvisual-youtube-'));
  const executable = process.env.LOUVORVISUAL_YTDLP_PATH || 'yt-dlp';
  const ffmpeg = process.env.LOUVORVISUAL_FFMPEG_PATH;
  const args = ['--ignore-config', '--no-playlist', '--no-progress', '--socket-timeout', '30', '--retries', '2', '--js-runtimes', 'node'];
  try {
    const { stdout } = await execute(executable, [...args, '--dump-single-json', '--skip-download', '--', url], { signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const metadata = JSON.parse(stdout) as Metadata;
    const durationMs = Math.round((metadata.duration ?? 0) * 1000);
    if (metadata.is_live || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 30 * 60_000)
      throw new AppError(400, 'VALIDATION_ERROR', 'Escolha uma gravação de até 30 minutos, sem transmissão ao vivo.');
    const { title, artist } = youtubeSongMetadata(metadata);
    if (!title || title.length > 200 || artist.length > 200) throw new AppError(422, 'VALIDATION_ERROR', 'Não foi possível identificar o título e o artista do vídeo.');
    const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let tracks = await lookup(title, artist, lookupSignal);
    if (!selectYoutubeLyrics(tracks, title, artist, durationMs) && artist) tracks = await lookup(title, '', lookupSignal);
    const lyrics = selectYoutubeLyrics(tracks, title, artist, durationMs);
    if (!lyrics?.syncedLyrics) throw new AppError(422, 'DEPENDENCY_NOT_READY', 'Não foi encontrada uma letra sincronizada compatível com o título, artista e duração desta gravação. Tente outra versão ou crie o louvor manualmente.');
    await execute(executable, [...args, ...(ffmpeg ? ['--ffmpeg-location', ffmpeg] : []),
      '--format', 'bestaudio/best', '--max-filesize', String(MAX_ASSET_BYTES), '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K',
      '--output', join(directory, 'audio.%(ext)s'), '--', url], { signal, timeout: 9 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const audioPath = join(directory, 'audio.mp3');
    const size = (await stat(audioPath)).size;
    if (!size || size > MAX_ASSET_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'O áudio convertido ultrapassa o limite permitido.');
    // A duração real após a conversão é a referência dos slides, não a estimativa do vídeo.
    const probe = ffmpeg ? join(ffmpeg, 'ffprobe') : 'ffprobe';
    const { stdout: measured } = await execute(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], { signal, timeout: 30_000, windowsHide: true });
    const actualMs = Math.round(Number(measured.trim()) * 1000);
    const chosen = selectYoutubeLyrics(tracks, title, artist, actualMs);
    if (!chosen?.syncedLyrics) throw new AppError(422, 'DEPENDENCY_NOT_READY', 'A letra encontrada não é compatível com a duração do áudio convertido.');
    return { title: chosen.trackName, artist: chosen.artistName, sourceUrl: url, durationMs: actualMs,
      rawLyrics: parseSyncedLyrics(chosen.syncedLyrics).map(line => line.text).join('\n'), syncedLyrics: chosen.syncedLyrics, lyricsId: chosen.id, audio: await readFile(audioPath) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) throw new AppError(504, 'DEPENDENCY_NOT_READY', 'A importação foi interrompida ou excedeu o tempo limite. Tente novamente.');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError(503, 'DEPENDENCY_NOT_READY', 'O servidor precisa de yt-dlp, FFmpeg e ffprobe para importar do YouTube.');
    throw new AppError(502, 'DEPENDENCY_NOT_READY', 'Não foi possível baixar e converter este vídeo. Verifique se ele está disponível e tente novamente.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
