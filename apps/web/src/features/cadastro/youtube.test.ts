import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entityKey } from '@louvorvisual/sync';
import { ensureProfile, readAssetBlob, type LocalSession } from '@/local';
import { testContext, testDatabase } from '@/local/testing';
import { silentMp3Bytes } from '@/lib/testAudio';
import { createYoutubeSong, publishYoutubeSong } from './youtube';

const mocks = vi.hoisted(() => ({ syncNow: vi.fn(), announceLibraryChange: vi.fn() }));
vi.mock('@/sync/engine', () => ({ syncEngine: () => mocks }));
vi.mock('../audio/htmlTransport', () => ({ probeAudio: async () => 180000, estimateFreeSpace: async () => null }));
let session: LocalSession;
afterEach(async () => { vi.unstubAllGlobals(); vi.clearAllMocks(); await session?.db.delete(); });
async function open() {
  const db = testDatabase(); const context = testContext(); const profile = await ensureProfile(db, context.newId, context.now);
  const team = { profileId: profile.profileId, dbName: db.name, userId: profile.userId, userName: 'Pessoa', userEmail: 'p@example.test', workspaceId: profile.workspaceId, workspaceName: 'Equipe', role: 'editor' as const, deviceId: profile.deviceId, createdAt: context.now, lastUsedAt: context.now };
  session = { db, profile, team, context: () => ({ ...context, workspaceId: profile.workspaceId, userId: profile.userId }) };
}
function response() {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ title: 'Louvor de teste', artist: 'Coral de teste', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', rawLyrics: 'Primeiro verso\nRefrão', syncedLyrics: '[00:12.00]Primeiro verso\n[01:20.00]Refrão', lyricsId: 1, durationMs: 180000 }));
  form.set('audio', new Blob([silentMp3Bytes(2)], { type: 'audio/mpeg' }), 'audio.mp3');
  return new Response(form);
}
describe('criar e publicar louvor do YouTube', () => {
  it('salva áudio e arranjo automático com os tempos reais da letra', async () => {
    await open(); vi.stubGlobal('fetch', vi.fn(async () => response()));
    const result = await createYoutubeSong(session, 'https://youtu.be/abcdefghijk', () => undefined);
    const arrangement = await session.db.arrangements.get(result.arrangementId);
    expect(arrangement?.defaultMode).toBe('automatic');
    expect(arrangement?.audioBindings[0]?.policy).toBe('linked');
    expect(arrangement?.audioBindings[0]?.cues.map(c => c.startMs)).toEqual([0,12000,80000]);
    expect(arrangement?.occurrences.map(o => o.durationMs)).toEqual([12000,68000,100000]);
    const asset = (await session.db.assets.get(result.assetId))!;
    expect((await readAssetBlob(session.db, asset.workspaceId, asset.sha256))?.size).toBe(asset.byteSize);
    expect(await session.db.songs.count()).toBe(1);
  });
  it('não confirma publicação antes dos documentos e dos bytes do áudio', async () => {
    await open(); vi.stubGlobal('fetch', vi.fn(async () => response()));
    const result = await createYoutubeSong(session, 'https://youtu.be/abcdefghijk', () => undefined);
    let done = false;
    const publishing = publishYoutubeSong(session, result).then(() => { done = true; });
    await session.db.entityStates.toCollection().modify({ dirty: 0, serverRevision: '1' });
    await vi.waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
    expect(done).toBe(false);
    await session.db.assets.update(result.assetId, { remoteState: 'ready' });
    await publishing;
    expect(done).toBe(true);
    await publishYoutubeSong(session, result);
    expect(await session.db.songs.count()).toBe(1);
  });
  it('mantém a cópia local quando a publicação é recusada', async () => {
    await open(); vi.stubGlobal('fetch', vi.fn(async () => response()));
    const result = await createYoutubeSong(session, 'https://youtu.be/abcdefghijk', () => undefined);
    await session.db.entityStates.update(entityKey('song', result.songId), { blocked: { code: 'FORBIDDEN', generation: 1, retryAt: null } });
    await expect(publishYoutubeSong(session, result)).rejects.toThrow('bloqueada');
    expect(await session.db.songs.count()).toBe(1);
  });
  it('falha sem salvar quando não há letra compatível e rejeita perfil pessoal antes da rede', async () => {
    await open(); const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Sem letra compatível.' } }), { status: 422 })); vi.stubGlobal('fetch', fetcher);
    await expect(createYoutubeSong(session, 'https://youtu.be/abcdefghijk', () => undefined)).rejects.toThrow('Sem letra compatível');
    expect(await session.db.songs.count()).toBe(0);
    session.team = null;
    await expect(createYoutubeSong(session, 'https://youtu.be/abcdefghijk', () => undefined)).rejects.toThrow('equipe');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
