import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importYoutube } from '../src/modules/import/youtube-import';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), mkdtemp: vi.fn(), readFile: vi.fn(), rm: vi.fn(), stat: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute }) }));
vi.mock('node:fs/promises', () => ({ mkdtemp: mocks.mkdtemp, readFile: mocks.readFile, rm: mocks.rm, stat: mocks.stat }));
const lyrics = { id: 1, trackName: 'Louvor', artistName: 'Coral', duration: 180, syncedLyrics: '[00:12.00]Verso\n[01:20.00]Refrão', instrumental: false };
beforeEach(() => {
  mocks.mkdtemp.mockResolvedValue('/tmp/louvorvisual-youtube-test'); mocks.rm.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ size: 8 }); mocks.readFile.mockResolvedValue(Buffer.from('ID3audio'));
  mocks.execute.mockImplementation(async (_exe: string, args: string[]) => ({ stdout: args.includes('--dump-single-json') ? JSON.stringify({ track: 'Louvor', artist: 'Coral', duration: 180 }) : args.includes('-show_entries') ? '180.000' : '' }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([lyrics]))));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe('download e conversão do YouTube', () => {
  it('converte MP3 e verifica a duração convertida antes de devolver a letra', async () => {
    const result = await importYoutube('https://youtu.be/abcdefghijk?list=ignore', new AbortController().signal);
    expect(result).toMatchObject({ title: 'Louvor', artist: 'Coral', durationMs: 180000, lyricsId: 1, audio: Buffer.from('ID3audio') });
    const download = mocks.execute.mock.calls[1]!;
    expect(download[1]).toContain('--extract-audio'); expect(download[1]).toContain('mp3');
    expect(download[1].at(-1)).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(download[2]).toMatchObject({ windowsHide: true });
    expect(mocks.execute.mock.calls[2]?.[1]).toContain('format=duration');
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/louvorvisual-youtube-test', { recursive: true, force: true });
  });
  it('não baixa áudio quando nenhuma letra corresponde à duração', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ ...lyrics, duration: 240 }]))));
    await expect(importYoutube('https://youtu.be/abcdefghijk', new AbortController().signal)).rejects.toMatchObject({ statusCode: 422 });
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.rm).toHaveBeenCalled();
  });
  it('rejeita discrepância na duração real após converter e remove temporários', async () => {
    mocks.execute.mockImplementation(async (_exe: string, args: string[]) => ({ stdout: args.includes('--dump-single-json') ? JSON.stringify({ track: 'Louvor', artist: 'Coral', duration: 180 }) : args.includes('-show_entries') ? '240.000' : '' }));
    await expect(importYoutube('https://youtu.be/abcdefghijk', new AbortController().signal)).rejects.toMatchObject({ statusCode: 422 });
    expect(mocks.readFile).not.toHaveBeenCalled(); expect(mocks.rm).toHaveBeenCalled();
  });
  it('informa a falta dos executáveis e limpa o diretório', async () => {
    mocks.execute.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(importYoutube('https://youtu.be/abcdefghijk', new AbortController().signal)).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_NOT_READY' });
    expect(mocks.rm).toHaveBeenCalled();
  });

  it.each([
    ['vídeo privado', 'ERROR: Private video', 422, 'não está disponível publicamente'],
    ['bloqueio do YouTube', 'ERROR: Sign in to confirm you’re not a bot', 502, 'bloqueou temporariamente'],
    ['FFmpeg ausente depois do download', 'ERROR: ffmpeg not found', 503, 'não encontrou FFmpeg'],
    ['extrator desatualizado', 'ERROR: Unable to extract player response', 502, 'Atualize o yt-dlp'],
  ])('explica %s sem expor detalhes do processo', async (_name, stderr, statusCode, message) => {
    mocks.execute.mockRejectedValue(Object.assign(new Error('command failed'), { stderr }));
    await expect(importYoutube('https://youtu.be/abcdefghijk', new AbortController().signal)).rejects.toMatchObject({ statusCode, message: expect.stringContaining(message) });
    expect(mocks.rm).toHaveBeenCalled();
  });
});
