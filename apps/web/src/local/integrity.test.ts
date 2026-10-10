import 'fake-indexeddb/auto';
import { touch, type Arrangement, type Song } from '@louvorvisual/domain';
import { SyncCoordinator } from '@louvorvisual/sync';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer, FakeTransport } from '../../../../packages/sync/src/testing';
import { wavBytes } from '@/lib/testAudio';
import { LocalAssetBytes } from '@/sync/assetBytes';
import { DexieSyncStorage } from '@/sync/dexieStorage';
import { importAudioFile, verifyAsset } from './assets';
import type { LocalDatabase } from './db';
import { discardMediaForDownload, repairDocument, scanIntegrity } from './integrity';
import { getEntityState, getSong, listRevisions, listSongIndex, saveDocuments } from './repository';
import { assetBlobKey } from './schema';
import { sampleSong, testContext, testDatabase } from './testing';

const context = testContext();
const NOW = '2026-10-06T18:00:00.000Z';
const databases: LocalDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});
function database() {
  const db = testDatabase();
  databases.push(db);
  return db;
}

let tick = 0;
function device(server: FakeServer) {
  const db = database();
  const storage = new DexieSyncStorage(db, { workspaceId: context.workspaceId, deviceId: crypto.randomUUID() });
  const coordinator = new SyncCoordinator({ storage, transport: new FakeTransport(server, context.userId), assets: new LocalAssetBytes(db, 'perfil'), workspaceId: context.workspaceId, now: () => new Date(Date.parse(NOW) + (tick += 1) * 1000).toISOString(), newId: () => crypto.randomUUID() });
  return { db, sync: () => coordinator.syncOnce(), download: (assetIds: string[]) => coordinator.requestDownloads(assetIds) };
}

/** Grava direto na tabela um registro que não passa no esquema, como um dado danificado. */
const damage = (db: LocalDatabase, song: Song) => db.songs.put({ ...song, sections: 'ilegível', title: 42 } as unknown as Song);

describe('conferência e reparo dos dados locais', () => {
  it('biblioteca íntegra: nenhum problema, e a conferência não altera nada', async () => {
    const db = database();
    const { song, arrangement } = sampleSong(context);
    await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    const report = await scanIntegrity(db, { verifyMedia: true, now: NOW });
    expect(report).toEqual({ checkedAt: NOW, documents: 2, mediaFiles: 0, mediaVerified: true, problems: [] });
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 1 });
  });

  it('documento ilegível já confirmado pela equipe volta à versão confirmada, limpo', async () => {
    const server = new FakeServer();
    const a = device(server);
    const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
    await saveDocuments(a.db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    await a.sync();
    await damage(a.db, song);

    const report = await scanIntegrity(a.db, { verifyMedia: false, now: NOW });
    expect(report.problems).toEqual([{ kind: 'document', entityType: 'song', entityId: song.id, title: song.id, repair: 'server' }]);
    expect(await repairDocument(a.db, 'song', song.id, NOW)).toBe('server');
    expect((await getSong(a.db, song.id))!).toMatchObject({ title: 'Manhã de Gratidão', rawLyrics: song.rawLyrics });
    expect((await listSongIndex(a.db, context.workspaceId))[0]).toMatchObject({ title: 'Manhã de Gratidão' });
    expect(await getEntityState(a.db, 'song', song.id)).toMatchObject({ dirty: 0, serverRevision: '1' });
    // O registro danificado não foi destruído: fica guardado como estava.
    expect((await listRevisions(a.db, 'song', song.id)).map((revision) => [revision.reason, (revision.document as unknown as { title: unknown }).title])).toEqual([['corrupted', 42]]);
    expect((await scanIntegrity(a.db, { verifyMedia: false, now: NOW })).problems).toEqual([]);
    // Nada é reenviado por causa do reparo.
    expect(await a.sync()).toMatchObject({ pushed: 0 });
  });

  it('documento ilegível só local volta à cópia válida mais recente do histórico, como alteração pendente', async () => {
    const db = database();
    const { song } = sampleSong(context, 'Original');
    await saveDocuments(db, [{ entityType: 'song', document: song }]);
    await saveDocuments(db, [{ entityType: 'song', document: touch({ ...song, title: 'Editado' }, { userId: context.userId, now: NOW }) }], { now: NOW });
    await damage(db, song);
    expect((await scanIntegrity(db, { verifyMedia: false, now: NOW })).problems).toMatchObject([{ repair: 'history' }]);
    expect(await repairDocument(db, 'song', song.id, NOW)).toBe('history');
    expect((await getSong(db, song.id))!.title).toBe('Original');
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ dirty: 1, localGeneration: 3 });
  });

  it('sem versão confirmada nem histórico: o registro ilegível sai da biblioteca, fica guardado, e a equipe o devolve na próxima base', async () => {
    const lonely = database();
    const { song } = sampleSong(context, 'Sem cópia');
    await saveDocuments(lonely, [{ entityType: 'song', document: song }]);
    await damage(lonely, song);
    expect((await scanIntegrity(lonely, { verifyMedia: false, now: NOW })).problems).toMatchObject([{ repair: 'none' }]);
    expect(await repairDocument(lonely, 'song', song.id, NOW)).toBe('removed');
    expect(await lonely.songs.get(song.id)).toBeUndefined();
    expect(await listSongIndex(lonely, context.workspaceId)).toEqual([]);
    expect(await lonely.revisions.where('workspaceId').equals(context.workspaceId).count()).toBe(1);

    // Em equipe, com a versão confirmada também danificada: a base nova traz o registro de volta.
    const server = new FakeServer();
    const a = device(server);
    const shared = sampleSong(context, 'Da equipe').song;
    await saveDocuments(a.db, [{ entityType: 'song', document: shared }]);
    await a.sync();
    await damage(a.db, shared);
    const state = (await getEntityState(a.db, 'song', shared.id))!;
    await a.db.entityStates.put({ ...state, lastAckSnapshot: { quebrado: true } as never });
    expect(await repairDocument(a.db, 'song', shared.id, NOW)).toBe('removed');
    expect(await a.sync()).toMatchObject({ bootstrapped: true });
    expect((await getSong(a.db, shared.id))!.title).toBe('Da equipe');
  });

  it('AT-22: faixa ausente, incompleta ou corrompida aparece com o louvor que a usa e com a saída possível', async () => {
    const db = database();
    const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
    const { asset } = await importAudioFile(db, { file: new Blob([wavBytes(2)], { type: 'audio/wav' }), filename: 'playback.wav', kind: 'playback', profileId: 'perfil', workspaceId: context.workspaceId, now: () => NOW, newId: context.newId, probe: async () => 2000 });
    const bound: Arrangement = { ...arrangement, audioBindings: [{ id: context.newId(), assetId: asset.id, kind: 'playback', policy: 'independent', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] }] };
    await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: bound },
    ]);
    const key = assetBlobKey(context.workspaceId, asset.sha256);
    expect((await scanIntegrity(db, { verifyMedia: true, now: NOW })).problems).toEqual([]);

    // Mesmo tamanho, bytes diferentes: só a conferência completa enxerga.
    const bytes = wavBytes(2);
    bytes[300] = (bytes[300] as number) ^ 0xff;
    await db.assetBlobs.update(key, { blob: new Blob([bytes]) });
    expect((await scanIntegrity(db, { verifyMedia: false, now: NOW })).problems).toEqual([]);
    expect((await scanIntegrity(db, { verifyMedia: true, now: NOW })).problems).toEqual([{ kind: 'media', assetId: asset.id, filename: 'playback.wav', issue: 'corrupted', repair: 'reimport', songTitles: ['Manhã de Gratidão'] }]);

    await db.assetBlobs.update(key, { state: 'staged' });
    expect((await scanIntegrity(db, { verifyMedia: false, now: NOW })).problems).toMatchObject([{ issue: 'incomplete' }]);
    await db.assetBlobs.delete(key);
    expect((await scanIntegrity(db, { verifyMedia: false, now: NOW })).problems).toMatchObject([{ issue: 'missing', repair: 'reimport' }]);
    // Arquivo que a equipe não tem não pode ser "baixado de novo".
    await expect(discardMediaForDownload(db, asset.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('AT-22: faixa corrompida que a equipe tem publicada é descartada e baixada de novo, conferida', async () => {
    const server = new FakeServer();
    const a = device(server);
    const b = device(server);
    const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
    const { asset } = await importAudioFile(a.db, { file: new Blob([wavBytes(2)], { type: 'audio/wav' }), filename: 'playback.wav', kind: 'playback', profileId: 'perfil', workspaceId: context.workspaceId, now: () => NOW, newId: context.newId, probe: async () => 2000 });
    const bound: Arrangement = { ...arrangement, audioBindings: [{ id: context.newId(), assetId: asset.id, kind: 'playback', policy: 'independent', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] }] };
    await saveDocuments(a.db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: bound },
    ]);
    await a.sync();
    expect(await b.sync()).toMatchObject({ downloaded: 0 });
    expect(await b.download([asset.id])).toMatchObject({ downloaded: 1 });

    const bytes = wavBytes(2);
    bytes[300] = (bytes[300] as number) ^ 0xff;
    await b.db.assetBlobs.update(assetBlobKey(context.workspaceId, asset.sha256), { blob: new Blob([bytes]) });
    expect((await scanIntegrity(b.db, { verifyMedia: true, now: NOW })).problems).toMatchObject([{ kind: 'media', issue: 'corrupted', repair: 'download' }]);
    await discardMediaForDownload(b.db, asset.id);
    expect(await b.sync()).toMatchObject({ downloaded: 0 });
    expect(await b.download([asset.id])).toMatchObject({ downloaded: 1 });
    expect(await verifyAsset(b.db, asset, NOW)).toBe('ok');
    expect((await scanIntegrity(b.db, { verifyMedia: true, now: NOW })).problems).toEqual([]);
  });
});
