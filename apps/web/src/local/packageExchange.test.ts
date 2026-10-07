import 'fake-indexeddb/auto';
import { addSetlistItem, createSetlist, deriveCues, touch, type Arrangement, type AuthoringContext, type Setlist, type Song } from '@louvorvisual/domain';
import { documentPath, mediaPath, openPackage, PackageError } from '@louvorvisual/pack';
import { SyncCoordinator } from '@louvorvisual/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, FakeTransport } from '../../../../packages/sync/src/testing';
import { repack } from '../../../../packages/pack/src/testing';
import { wavBytes } from '@/lib/testAudio';
import { LocalAssetBytes } from '@/sync/assetBytes';
import { DexieSyncStorage } from '@/sync/dexieStorage';
import { hashBlob, importAudioFile, readAssetBlob, verifyAsset } from './assets';
import type { LocalDatabase } from './db';
import { applyImport, estimateSetlistPackage, exportSetlistPackage, ImportFailure, previewImport, type ImportContext } from './packageExchange';
import { countPending, getEntityState, saveDocuments } from './repository';
import { assetBlobKey } from './schema';
import { resolveSetlist } from './setlists';
import { sampleSong, testContext, testDatabase } from './testing';

const origin = testContext();
const OTHER: AuthoringContext = { ...testContext('2026-10-06T15:00:00.000Z'), workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const databases: LocalDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});

function database(): LocalDatabase {
  const db = testDatabase();
  databases.push(db);
  return db;
}

const importContext = (context: AuthoringContext): ImportContext => ({ workspaceId: context.workspaceId, userId: context.userId, profileId: 'perfil-de-teste', now: context.now, newId: context.newId });
const audio = (frequency: number) => new Blob([wavBytes(4, { frequency })], { type: 'audio/wav' });

/** Repertório com dois louvores; o primeiro tem playback vinculado e uma faixa original extra. */
async function library() {
  const db = database();
  const first = sampleSong(origin, 'Manhã de Gratidão');
  const second = sampleSong(origin, 'Canção da Colheita');
  const add = async (file: Blob, kind: 'playback' | 'original', filename: string) =>
    (await importAudioFile(db, { file, filename, kind, profileId: 'perfil-de-teste', workspaceId: origin.workspaceId, now: () => origin.now, newId: origin.newId, probe: async () => 4000 })).asset;
  const playback = await add(audio(440), 'playback', 'playback-manha.wav');
  const original = await add(audio(660), 'original', 'original-manha.wav');
  const timed = first.arrangement.occurrences.map((occurrence) => ({ ...occurrence, durationMs: 1000 }));
  const bindingId = origin.newId();
  const arrangement: Arrangement = {
    ...first.arrangement,
    occurrences: timed,
    audioBindings: [
      { id: bindingId, assetId: playback.id, kind: 'playback', policy: 'linked', volume: 0.8, offsetMs: 0, cuesVersion: 1, cues: deriveCues(timed, 0) ?? [] },
      { id: origin.newId(), assetId: original.id, kind: 'original', policy: 'independent', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] },
    ],
    selectedAudioBindingId: bindingId,
  };
  let setlist: Setlist = createSetlist({ title: 'Culto de domingo', serviceDate: '2026-10-11', timeZone: 'America/Sao_Paulo' }, origin);
  setlist = { ...setlist, items: addSetlistItem(addSetlistItem(setlist.items, arrangement.id, origin.newId), second.arrangement.id, origin.newId) };
  await saveDocuments(db, [
    { entityType: 'song', document: first.song },
    { entityType: 'arrangement', document: arrangement },
    { entityType: 'song', document: second.song },
    { entityType: 'arrangement', document: second.arrangement },
    { entityType: 'setlist', document: setlist },
  ]);
  return { db, setlist, song: first.song, arrangement, second, playback, original };
}

const exportOptions = { mediaPolicy: 'all' as const, profileKind: 'personal' as const, now: '2026-10-06T14:00:00.000Z', newId: () => crypto.randomUUID() };

async function snapshot(db: LocalDatabase) {
  const tables = [db.songs, db.arrangements, db.setlists, db.assets, db.themes, db.entityStates, db.songIndex, db.importMap, db.revisions];
  const rows = await Promise.all(tables.map((table) => table.toArray()));
  const blobs = (await db.assetBlobs.toArray()).map(({ blob, ...row }) => ({ ...row, size: blob.size }));
  return JSON.stringify([rows, blobs]);
}

describe('pacote de repertório sobre o banco local', () => {
  it('AT-18: exporta de um dispositivo e importa em outro perfil, com documentos, áudio íntegro e IDs remapeados', async () => {
    const source = await library();
    const estimate = await estimateSetlistPackage(source.db, source.setlist.id);
    expect(estimate).toEqual({ documents: 7, mediaBytes: { all: source.playback.byteSize + source.original.byteSize, selected: source.playback.byteSize, none: 0 } });
    const before = await snapshot(source.db);
    const progress: [number, number][] = [];
    const { file, manifest, filename } = await exportSetlistPackage(source.db, source.setlist.id, { ...exportOptions, onProgress: (loaded, total) => progress.push([loaded, total]) });
    // Exportar só lê: nada muda na biblioteca de origem.
    expect(await snapshot(source.db)).toBe(before);
    expect(filename).toBe('repertorio-culto-de-domingo-20261006.louvorvisual.zip');
    expect(progress.at(-1)).toEqual([estimate.mediaBytes.all, estimate.mediaBytes.all]);
    expect(manifest.entries.filter((entry) => entry.kind === 'media').map((entry) => entry.path).sort()).toEqual([mediaPath(source.playback.sha256), mediaPath(source.original.sha256)].sort());
    expect(manifest.origin).toEqual({ workspaceId: origin.workspaceId, profileKind: 'personal' });

    const target = database();
    const context = importContext(OTHER);
    const preview = await previewImport(target, file, context);
    expect(preview.plan).toMatchObject({ sameWorkspace: false, counts: { copy: 7, insert: 0, reuse: 0 } });
    expect(preview.newMediaBytes).toBe(estimate.mediaBytes.all);
    // A prévia não grava nada.
    expect(await target.songs.count()).toBe(0);
    expect(await target.assetBlobs.count()).toBe(0);

    const result = await applyImport(target, preview.opened, context);
    expect(result).toMatchObject({ mediaStored: 2, mediaReused: 0 });
    const setlist = (await target.setlists.get(result.setlistId))!;
    expect(setlist).toMatchObject({ title: 'Culto de domingo', serviceDate: '2026-10-11', workspaceId: OTHER.workspaceId, serverRevision: null, createdBy: OTHER.userId });
    expect(setlist.id).not.toBe(source.setlist.id);
    const entries = await resolveSetlist(target, setlist);
    expect(entries.map((entry) => entry.song?.title)).toEqual(['Manhã de Gratidão', 'Canção da Colheita']);
    const arrangement = entries[0]!.arrangement!;
    expect(arrangement.id).not.toBe(source.arrangement.id);
    expect(arrangement.songId).toBe(entries[0]!.song!.id);
    expect(entries[0]!.song!.rawLyrics).toBe(source.song.rawLyrics);
    expect(arrangement.occurrences).toEqual(source.arrangement.occurrences);
    expect(arrangement.audioBindings[0]!.cues).toEqual(source.arrangement.audioBindings[0]!.cues);

    // Os arquivos chegam com os mesmos bytes, publicados como prontos e conferíveis.
    for (const [index, sourceAsset] of [source.playback, source.original].entries()) {
      const asset = (await target.assets.get(arrangement.audioBindings[index]!.assetId))!;
      expect(asset).toMatchObject({ sha256: sourceAsset.sha256, byteSize: sourceAsset.byteSize, workspaceId: OTHER.workspaceId, remoteState: 'local', storageKey: null });
      expect(asset.id).not.toBe(sourceAsset.id);
      expect(await verifyAsset(target, asset, OTHER.now)).toBe('ok');
      expect(await hashBlob((await readAssetBlob(target, OTHER.workspaceId, asset.sha256))!)).toBe(sourceAsset.sha256);
    }
    // Tudo fica pendente como criação local; nada da situação de sincronização da origem veio junto.
    expect(await countPending(target, OTHER.workspaceId)).toBe(7);
    expect(await getEntityState(target, 'song', entries[0]!.song!.id)).toMatchObject({ serverRevision: null, dirty: 1, localGeneration: 1, lastAckSnapshot: null, conflict: null });
    expect(await target.syncOperations.count()).toBe(0);
  });

  it('importação repetida: nada é duplicado nem regravado, mesmo com outro arquivo do mesmo repertório', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const context = importContext(OTHER);
    const first = await applyImport(target, (await previewImport(target, file, context)).opened, context);
    const after = await snapshot(target);

    const again = await previewImport(target, file, context);
    expect(again.plan).toMatchObject({ counts: { copy: 0, insert: 0, reuse: 7 }, writes: [] });
    expect(again.newMediaBytes).toBe(0);
    const second = await applyImport(target, again.opened, { ...context, now: '2026-10-07T09:00:00.000Z' });
    expect(second).toMatchObject({ setlistId: first.setlistId, mediaStored: 0, mediaReused: 2 });
    expect(await target.songs.count()).toBe(2);
    expect(await target.setlists.count()).toBe(1);
    expect(await target.assets.count()).toBe(2);
    expect(await target.assetBlobs.count()).toBe(2);
    expect(await getEntityState(target, 'setlist', first.setlistId)).toMatchObject({ localGeneration: 1 });
    // Só o registro do mapa de importação é regravado (data e pacote).
    expect(JSON.stringify(await target.songs.toArray())).toBe(JSON.stringify(JSON.parse(after)[0][0]));

    const reexported = await exportSetlistPackage(source.db, source.setlist.id, { ...exportOptions, now: '2026-10-08T10:00:00.000Z' });
    const third = await applyImport(target, await openPackage(reexported.file), context);
    expect(third.plan.counts).toEqual({ copy: 0, insert: 0, reuse: 7 });
    expect(await target.songs.count()).toBe(2);
  });

  it('mesmo espaço: reimportar no dispositivo de origem não muda nada; com edição local posterior, entra uma cópia e o local fica intacto', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const context = importContext(origin);
    const before = await snapshot(source.db);
    const same = await applyImport(source.db, await openPackage(file), context);
    expect(same.plan).toMatchObject({ sameWorkspace: true, counts: { copy: 0, insert: 0, reuse: 7 }, setlistId: source.setlist.id });
    expect(JSON.parse(await snapshot(source.db))[0].slice(0, 7)).toEqual(JSON.parse(before)[0].slice(0, 7));

    const edited: Song = touch({ ...source.song, title: 'Manhã de Gratidão (versão do ensaio)' }, origin);
    await saveDocuments(source.db, [{ entityType: 'song', document: edited }]);
    const result = await applyImport(source.db, await openPackage(file), context);
    expect(result.plan.diverged).toBeGreaterThan(0);
    expect(result.setlistId).not.toBe(source.setlist.id);
    expect(await source.db.songs.get(source.song.id)).toEqual(edited);
    expect(await source.db.setlists.get(source.setlist.id)).toEqual(source.setlist);
    const copy = (await source.db.setlists.get(result.setlistId))!;
    expect(copy.title).toBe('Culto de domingo (importado)');
    expect((await resolveSetlist(source.db, copy)).map((entry) => entry.song?.title)).toEqual(['Manhã de Gratidão (importado)', 'Canção da Colheita']);
    // Os bytes de áudio não foram duplicados: a cópia usa os mesmos arquivos.
    expect(await source.db.assets.count()).toBe(2);
    expect(await source.db.assetBlobs.count()).toBe(2);
  });

  it('mesmo espaço: documento que chega entre a conferência e a gravação (sincronização, outra janela) não é substituído', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    // Outro dispositivo da mesma equipe: mesmo espaço, biblioteca ainda vazia.
    const target = database();
    const context = importContext(origin);
    const preview = await previewImport(target, file, context);
    expect(preview.plan.counts).toMatchObject({ insert: 7, copy: 0 });

    // A consulta de espaço livre acontece depois do plano e antes da gravação:
    // é onde uma revisão da equipe pode chegar com o mesmo ID.
    const arrived: Song = { ...source.song, title: 'Manhã de Gratidão (versão da equipe)' };
    const result = await applyImport(target, preview.opened, context, {
      freeSpace: async () => {
        await saveDocuments(target, [{ entityType: 'song', document: arrived }]);
        return null;
      },
    });
    expect((await target.songs.get(source.song.id))?.title).toBe('Manhã de Gratidão (versão da equipe)');
    const songs = await target.songs.toArray();
    expect(songs.map((song) => song.title).sort()).toEqual(['Canção da Colheita', 'Manhã de Gratidão (importado)', 'Manhã de Gratidão (versão da equipe)']);
    // O arranjo importado aponta para a cópia, não para o louvor que chegou.
    const entries = await resolveSetlist(target, (await target.setlists.get(result.setlistId))!);
    expect(entries[0]!.song!.title).toBe('Manhã de Gratidão (importado)');
    expect(result.plan.diverged).toBeGreaterThan(0);
  });

  it('pacote adulterado é recusado na área de preparação e a biblioteca de destino não é tocada', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const existing = sampleSong(OTHER, 'Já estava aqui');
    await saveDocuments(target, [{ entityType: 'song', document: existing.song }]);
    const before = await snapshot(target);
    const context = importContext(OTHER);

    const flipped = wavBytes(4, { frequency: 440 });
    flipped[1000] = (flipped[1000] as number) ^ 0xff;
    const badMedia = await repack(file, { files: { [mediaPath(source.playback.sha256)]: flipped } });
    await expect(previewImport(target, badMedia, context)).rejects.toMatchObject({ name: 'PackageError', code: 'hash-mismatch' });

    const badDocument = await repack(file, { files: { [documentPath('song', source.song.id)]: JSON.stringify({ ...source.song, title: 'Trocado' }) } });
    await expect(previewImport(target, badDocument, context)).rejects.toBeInstanceOf(PackageError);
    const forged = await repack(file, { files: { [documentPath('song', source.song.id)]: JSON.stringify({ ...source.song, workspaceId: OTHER.workspaceId }) }, fixHashes: true });
    await expect(previewImport(target, forged, context)).rejects.toMatchObject({ code: 'reference-broken' });
    await expect(previewImport(target, new Blob([new Uint8Array(await file.arrayBuffer()).subarray(0, file.size - 100)]), context)).rejects.toMatchObject({ code: 'not-a-package' });
    expect(await snapshot(target)).toBe(before);
  });

  it('versão incompatível: pacote de formato ou esquema mais novo não é importado', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const context = importContext(OTHER);
    const newerFormat = await repack(file, { manifest: (manifest) => void (manifest.minReaderVersion = 2) });
    await expect(previewImport(target, newerFormat, context)).rejects.toMatchObject({ code: 'format-too-new' });
    const newerSchema = await repack(file, { manifest: (manifest) => void (manifest.schemaVersion = 2) });
    await expect(previewImport(target, newerSchema, context)).rejects.toMatchObject({ code: 'schema-too-new' });
    await expect(previewImport(target, file, context, { support: { fontPackVersion: '2' } })).rejects.toMatchObject({ code: 'font-pack-incompatible' });
    expect(await target.setlists.count()).toBe(0);
    expect(await target.importMap.count()).toBe(0);
  });

  it('AT-22: sem espaço para o áudio do pacote, nada é importado — nem documentos, nem bytes parciais', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const context = importContext(OTHER);
    const existing = sampleSong(OTHER, 'Já estava aqui');
    await saveDocuments(target, [{ entityType: 'song', document: existing.song }]);
    const before = await snapshot(target);
    const opened = await openPackage(file);

    // Estimativa do navegador menor do que o necessário: recusa antes de escrever.
    const refused = await applyImport(target, opened, context, { freeSpace: async () => 1000 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ImportFailure);
    expect(refused).toMatchObject({ code: 'quota' });
    expect((refused as Error).message).toContain('Nada foi importado');
    expect(await snapshot(target)).toBe(before);

    // QuotaExceededError na segunda faixa: a primeira, já escrita, é desfeita.
    const realPut = target.assetBlobs.put.bind(target.assetBlobs);
    let calls = 0;
    vi.spyOn(target.assetBlobs, 'put').mockImplementation((...args: Parameters<typeof realPut>) => {
      calls += 1;
      return calls === 2 ? (Promise.reject(Object.assign(new Error('cheio'), { name: 'QuotaExceededError' })) as ReturnType<typeof realPut>) : realPut(...args);
    });
    await expect(applyImport(target, opened, context)).rejects.toMatchObject({ code: 'quota' });
    vi.restoreAllMocks();
    expect(await snapshot(target)).toBe(before);

    // Falha dentro da transação final (documentos): os bytes preparados também saem.
    vi.spyOn(target.setlists, 'put').mockRejectedValueOnce(Object.assign(new Error('cheio'), { name: 'QuotaExceededError' }));
    await expect(applyImport(target, opened, context)).rejects.toMatchObject({ code: 'quota' });
    vi.restoreAllMocks();
    expect(await snapshot(target)).toBe(before);

    // Com espaço, a mesma importação passa inteira.
    const result = await applyImport(target, opened, context, { freeSpace: async () => 1024 * 1024 * 1024 });
    expect(result.mediaStored).toBe(2);
    expect(await target.songs.count()).toBe(3);
  });

  it('AT-22: importar conserta bytes locais corrompidos, e mídia corrompida na origem não sai como íntegra', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const context = importContext(OTHER);
    const first = await applyImport(target, await openPackage(file), context);
    const key = assetBlobKey(OTHER.workspaceId, source.playback.sha256);
    const damaged = wavBytes(4, { frequency: 440 });
    damaged[500] = (damaged[500] as number) ^ 0xff;
    await target.assetBlobs.update(key, { blob: new Blob([damaged]) });
    const again = await applyImport(target, await openPackage(file), context);
    expect(again).toMatchObject({ setlistId: first.setlistId, mediaStored: 1, mediaReused: 1 });
    expect(await hashBlob((await readAssetBlob(target, OTHER.workspaceId, source.playback.sha256))!)).toBe(source.playback.sha256);

    // Na origem: o mesmo dano faz a faixa ficar fora do pacote, declarada como indisponível.
    await source.db.assetBlobs.update(assetBlobKey(origin.workspaceId, source.playback.sha256), { blob: new Blob([damaged]) });
    const partial = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    expect(partial.manifest.omittedMedia).toEqual([{ assetId: source.playback.id, sha256: source.playback.sha256, byteSize: source.playback.byteSize, reason: 'unavailable' }]);
    const fresh = database();
    const imported = await applyImport(fresh, await openPackage(partial.file), context);
    const arrangement = (await resolveSetlist(fresh, (await fresh.setlists.get(imported.setlistId))!))[0]!.arrangement!;
    const asset = (await fresh.assets.get(arrangement.audioBindings[0]!.assetId))!;
    // O documento do arquivo chega, mas sem bytes: a preparação do repertório acusa a falta.
    expect(await verifyAsset(fresh, asset, OTHER.now)).toBe('missing');
  });

  it('repertório com item cujo louvor foi excluído não é exportado', async () => {
    const source = await library();
    await saveDocuments(source.db, [{ entityType: 'song', document: { ...touch(source.second.song, origin), deletedAt: origin.now } }]);
    const error = await exportSetlistPackage(source.db, source.setlist.id, exportOptions).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'PackageError', code: 'incomplete' });
    expect((error as Error).message).toContain('o louvor do item 2');
  });

  it('importar em um perfil de equipe: o conteúdo é publicado como criação, na ordem das dependências, sem sobrescrever a equipe', async () => {
    const source = await library();
    const { file } = await exportSetlistPackage(source.db, source.setlist.id, exportOptions);
    const target = database();
    const context = importContext(OTHER);
    await applyImport(target, await openPackage(file), context);

    const server = new FakeServer();
    const storage = new DexieSyncStorage(target, { workspaceId: OTHER.workspaceId, deviceId: crypto.randomUUID() });
    let tick = 0;
    const coordinator = new SyncCoordinator({
      storage,
      transport: new FakeTransport(server, OTHER.userId),
      assets: new LocalAssetBytes(target, 'perfil-de-teste'),
      workspaceId: OTHER.workspaceId,
      now: () => new Date(Date.parse('2026-10-06T16:00:00.000Z') + (tick += 1) * 1000).toISOString(),
      newId: () => crypto.randomUUID(),
    });
    const outcome = await coordinator.syncOnce();
    expect(outcome).toMatchObject({ connection: 'idle', uploaded: 2, conflictsOpened: 0 });
    const sent = server.pushLog.flatMap((push) => push.operations);
    expect(sent.every((operation) => operation.action === 'create' && operation.baseRevision === '0' && operation.payload.workspaceId === OTHER.workspaceId)).toBe(true);
    expect(sent.map((operation) => operation.entityType)).toEqual(['asset', 'asset', 'song', 'song', 'arrangement', 'arrangement', 'setlist']);
    expect(await countPending(target, OTHER.workspaceId)).toBe(0);
  });
});
