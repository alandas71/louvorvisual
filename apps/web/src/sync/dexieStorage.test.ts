import 'fake-indexeddb/auto';
import { adoptDeferredRemote, entityKey, listOpenConflicts, listPending, resolveKeepRemote, SyncCoordinator, type AssetDoc, type SyncDoc } from '@louvorvisual/sync';
import { touch, type Song } from '@louvorvisual/domain';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, FakeTransport } from '../../../../packages/sync/src/testing';
import { LocalDatabase } from '@/local/db';
import { getEntityState, getSong, listRevisions, listSongIndex, saveDocuments } from '@/local/repository';
import { assetBlobKey, LOCAL_DB_VERSION } from '@/local/schema';
import { sampleSong, testContext, testDatabase } from '@/local/testing';
import { LocalAssetBytes } from './assetBytes';
import { DexieSyncStorage } from './dexieStorage';
import { acquireEditLease, editLockName } from './leases';

const databases: LocalDatabase[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});

const context = testContext();
let ids = 0;

/** Um dispositivo de verdade no que importa: banco Dexie próprio, repositório do aplicativo e coordenador. */
function device(server: FakeServer, userId = context.userId) {
  const db = testDatabase();
  databases.push(db);
  const storage = new DexieSyncStorage(db, { workspaceId: context.workspaceId, deviceId: crypto.randomUUID() });
  const transport = new FakeTransport(server, userId);
  const coordinator = new SyncCoordinator({
    storage,
    transport,
    assets: new LocalAssetBytes(db, 'perfil-de-teste'),
    workspaceId: context.workspaceId,
    now: () => new Date(Date.parse('2026-10-06T10:00:00.000Z') + (ids += 1) * 1000).toISOString(),
    newId: () => crypto.randomUUID(),
  });
  return { db, storage, transport, coordinator, sync: () => coordinator.syncOnce() };
}

const retitle = (song: Song, title: string) => touch({ ...song, title }, testContext('2026-10-06T09:00:00.000Z'));

async function pair() {
  const server = new FakeServer();
  const a = device(server);
  const b = device(server);
  const { song, arrangement } = sampleSong(context);
  await saveDocuments(a.db, [
    { entityType: 'song', document: song },
    { entityType: 'arrangement', document: arrangement },
  ]);
  await a.sync();
  await b.sync();
  return { server, a, b, song, arrangement };
}

describe('coordenador sobre o banco local (Dexie)', () => {
  it('cria com o repositório do aplicativo, envia em ordem e converge no segundo banco, com índice de busca', async () => {
    const { server, a, b, song, arrangement } = await pair();
    expect(server.pushLog.map((push) => push.operations.map((operation) => operation.entityType))).toEqual([['song'], ['arrangement']]);
    expect(await getEntityState(a.db, 'song', song.id)).toMatchObject({ dirty: 0, serverRevision: '1', localGeneration: 1 });
    expect(await a.db.syncOperations.count()).toBe(0);

    expect((await getSong(b.db, song.id))?.title).toBe(song.title);
    expect(await b.db.arrangements.get(arrangement.id)).toMatchObject({ songId: song.id, basedOnSongRevision: '1' });
    expect(await listSongIndex(b.db, context.workspaceId)).toMatchObject([{ id: song.id }]);
    expect(await getEntityState(b.db, 'arrangement', arrangement.id)).toMatchObject({ dirty: 0, serverRevision: '1', localGeneration: 0 });
    expect((await b.db.syncMeta.get('sync'))?.cursor).toBe('2');
    expect(await b.db.syncStaging.count()).toBe(0);
  });

  it('ack antigo não limpa nem substitui a geração gravada depois pelo editor', async () => {
    const { server, a, song } = await pair();
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Geração 2') }]);
    a.transport.faults.beforePush = async () => {
      a.transport.faults.beforePush = null;
      await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Geração 3, digitada durante o envio') }]);
    };
    // Um único envio: observar o estado logo depois da confirmação da geração 2.
    const push = a.transport.push.bind(a.transport);
    let calls = 0;
    a.transport.push = async (deviceId, operations) => {
      calls += 1;
      if (calls > 1) throw new (await import('@louvorvisual/sync')).TransportError('network', 0, 'NETWORK_ERROR', 'sem rede');
      return push(deviceId, operations);
    };
    await a.sync();
    expect((server.documentOf('song', song.id) as Song).title).toBe('Geração 2');
    expect((await getSong(a.db, song.id))?.title).toBe('Geração 3, digitada durante o envio');
    expect(await getEntityState(a.db, 'song', song.id)).toMatchObject({ dirty: 1, serverRevision: '2', localGeneration: 3 });
    // A tentativa da geração 3 ficou persistida e será repetida igual.
    const [queued] = await a.db.syncOperations.toArray();
    expect(queued).toMatchObject({ capturedGeneration: 3, baseRevision: '2', attempts: 1 });
    a.transport.push = push;
    await a.sync();
    expect(server.pushLog.at(-1)!.operations[0]!.opId).toBe(queued!.opId);
    expect(await getEntityState(a.db, 'song', song.id)).toMatchObject({ dirty: 0, serverRevision: '3' });
  });

  it('conflito preserva as duas variantes; "manter remoto" arquiva a local como revisão recuperável', async () => {
    const { a, b, song } = await pair();
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Versão de A') }]);
    await saveDocuments(b.db, [{ entityType: 'song', document: retitle(song, 'Versão de B') }]);
    await a.sync();
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    const [conflict] = await listOpenConflicts(b.storage);
    expect(conflict).toMatchObject({ baseRevision: '1', remoteRevision: '2' });
    expect((await getSong(b.db, song.id))?.title).toBe('Versão de B');
    expect((await listPending(b.storage, new Date().toISOString())).map((item) => item.phase)).toEqual(['conflict']);

    // Uma edição local com o conflito aberto não apaga a marcação de conflito.
    await saveDocuments(b.db, [{ entityType: 'song', document: retitle(song, 'Versão de B, revisada') }]);
    expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ conflict: conflict!.id, dirty: 1 });

    await resolveKeepRemote({ storage: b.storage, now: () => '2026-10-06T12:00:00.000Z' }, conflict!.id);
    expect((await getSong(b.db, song.id))?.title).toBe('Versão de A');
    expect((await listSongIndex(b.db, context.workspaceId))[0]).toMatchObject({ title: 'Versão de A' });
    const archived = await listRevisions(b.db, 'song', song.id);
    // Duas cópias: a versão original, guardada pelo histórico na primeira edição de B, e a variante local do conflito.
    expect(archived.map((revision) => revision.reason).sort()).toEqual(['conflict-local', 'edit']);
    expect((archived.find((revision) => revision.reason === 'conflict-local')!.document as Song).title).toBe('Versão de B, revisada');
    expect((archived.find((revision) => revision.reason === 'edit')!.document as Song).title).toBe(song.title);
    expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2', conflict: null });
  });

  it('AT-24: com o editor aberto (marcação válida), o pull não troca o documento; marcação vencida não segura', async () => {
    const { a, b, song } = await pair();
    vi.stubGlobal('navigator', {});
    const key = entityKey('song', song.id);
    await b.db.editLeases.put({ id: `${key}|editor`, key, holder: 'editor', expiresAt: Date.now() + 60_000 });
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Remoto') }]);
    await a.sync();
    await b.sync();
    expect((await getSong(b.db, song.id))?.title).toBe(song.title);
    expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ serverRevision: '1', dirty: 0, deferredRemote: { revision: '2' } });

    // O editor grava depois disso: a marcação de remoto adiado sobrevive e vira conflito, não sobrescrita.
    await saveDocuments(b.db, [{ entityType: 'song', document: retitle(song, 'Digitado no editor') }]);
    expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ dirty: 1, deferredRemote: { revision: '2' } });
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    expect((await getSong(b.db, song.id))?.title).toBe('Digitado no editor');

    // Outro louvor, com marcação de uma aba que fechou sem avisar.
    const other = sampleSong(context, 'Outro').song;
    await saveDocuments(a.db, [{ entityType: 'song', document: other }]);
    await a.sync();
    await b.sync();
    const otherKey = entityKey('song', other.id);
    await b.db.editLeases.put({ id: `${otherKey}|morta`, key: otherKey, holder: 'morta', expiresAt: Date.now() - 1 });
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(other, 'Outro, revisão 2') }]);
    await a.sync();
    await b.sync();
    expect((await getSong(b.db, other.id))?.title).toBe('Outro, revisão 2');
  });

  it('AT-24: editor vivo com a marcação vencida (aba em segundo plano, timers atrasados) continua protegido', async () => {
    const { a, b, song } = await pair();
    const key = entityKey('song', song.id);
    // O navegador informa as travas: a janela "viva" ainda existe, a "morta" não.
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: editLockName('viva') }] }) } });
    try {
      await b.db.editLeases.put({ id: `${key}|viva`, key, holder: 'viva', expiresAt: Date.now() - 60_000, createdAt: Date.now() - 600_000 });
      await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Remoto') }]);
      await a.sync();
      await b.sync();
      // Sem isto, o documento seria trocado por baixo do editor e a próxima
      // digitação sairia como `update` sobre a revisão 2, apagando a edição remota.
      expect((await getSong(b.db, song.id))?.title).toBe(song.title);
      expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ serverRevision: '1', deferredRemote: { revision: '2' } });
      await saveDocuments(b.db, [{ entityType: 'song', document: retitle(song, 'Digitado ao voltar') }]);
      expect(await b.sync()).toMatchObject({ conflictsOpened: 1, pushed: 0 });

      // Abrir outro editor limpa marcações vencidas, mas só as de janelas que não existem mais.
      const otherKey = entityKey('song', crypto.randomUUID());
      await b.db.editLeases.put({ id: `${otherKey}|morta`, key: otherKey, holder: 'morta', expiresAt: Date.now() - 60_000, createdAt: Date.now() - 600_000 });
      const release = await acquireEditLease(b.db, [entityKey('song', crypto.randomUUID())]);
      await expect.poll(() => b.db.editLeases.get(`${otherKey}|morta`)).toBeUndefined();
      expect(await b.db.editLeases.get(`${key}|viva`)).toBeDefined();
      release();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('carregar a versão remota adiada troca documento e índice numa única transação', async () => {
    const { a, b, song } = await pair();
    vi.stubGlobal('navigator', {});
    const key = entityKey('song', song.id);
    await b.db.editLeases.put({ id: `${key}|editor`, key, holder: 'editor', expiresAt: Date.now() + 60_000 });
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Remoto') }]);
    await a.sync();
    await b.sync();
    expect(await adoptDeferredRemote({ storage: b.storage, now: () => '2026-10-06T12:00:00.000Z' }, key)).toBe(true);
    expect((await getSong(b.db, song.id))?.title).toBe('Remoto');
    expect(await getEntityState(b.db, 'song', song.id)).toMatchObject({ serverRevision: '2', dirty: 0, deferredRemote: null });
  });

  it('falha no meio de uma transação não deixa documento sem a sua situação (tudo ou nada)', async () => {
    const { b, song } = await pair();
    const before = await getEntityState(b.db, 'song', song.id);
    await expect(
      b.storage.transaction(async (tx) => {
        await tx.putDocument('song', { ...(await tx.getDocument('song', song.id))!, title: 'Meio gravado' } as SyncDoc);
        await tx.putMeta({ ...(await tx.getMeta()), cursor: '999' });
        throw new Error('queda simulada');
      }),
    ).rejects.toThrow('queda simulada');
    expect((await getSong(b.db, song.id))?.title).toBe(song.title);
    expect((await listSongIndex(b.db, context.workspaceId))[0]).toMatchObject({ title: song.title });
    expect((await b.db.syncMeta.get('sync'))?.cursor).toBe('2');
    expect(await getEntityState(b.db, 'song', song.id)).toEqual(before);
  });

  it('reinício com tentativa em trânsito: o registro persistido no IndexedDB é repetido, não recriado', async () => {
    const { server, a, song } = await pair();
    await saveDocuments(a.db, [{ entityType: 'song', document: retitle(song, 'Enviado, resposta perdida') }]);
    a.transport.faults.loseResponses = 1;
    expect(await a.sync()).toMatchObject({ connection: 'offline' });
    const [persisted] = await a.db.syncOperations.toArray();
    expect(persisted?.firstSentAt).not.toBeNull();

    // Fecha e reabre o banco, como um navegador reiniciado.
    const name = a.db.name;
    a.db.close();
    const reopened = new LocalDatabase(name);
    databases.push(reopened);
    const storage = new DexieSyncStorage(reopened, { workspaceId: context.workspaceId, deviceId: 'ignorado-porque-ja-existe' });
    const coordinator = new SyncCoordinator({ storage, transport: a.transport, assets: new LocalAssetBytes(reopened, 'p'), workspaceId: context.workspaceId, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    expect(await coordinator.syncOnce()).toMatchObject({ connection: 'idle', conflictsOpened: 0 });
    expect(server.pushLog.at(-1)!.operations[0]!.opId).toBe(persisted!.opId);
    expect(server.eventsFor(song.id)).toHaveLength(2);
    expect(await getEntityState(reopened, 'song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2' });
  });

  it('download só publica bytes que conferem com tamanho e SHA-256', async () => {
    const db = testDatabase();
    databases.push(db);
    const bytes = new LocalAssetBytes(db, 'perfil');
    const content = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const { hashBlob } = await import('@/local/assets');
    const asset = { workspaceId: context.workspaceId, sha256: await hashBlob(content), byteSize: 4, mimeType: 'audio/wav' } as AssetDoc;
    expect(await bytes.write(asset, new Blob([new Uint8Array([9, 9, 9, 9])]))).toBe('mismatch');
    expect(await bytes.write(asset, new Blob([new Uint8Array([1, 2, 3])]))).toBe('mismatch');
    expect(await bytes.has(asset)).toBe(false);
    expect(await db.assetBlobs.count()).toBe(0);
    expect(await bytes.write(asset, content)).toBe('stored');
    expect(await db.assetBlobs.get(assetBlobKey(asset.workspaceId, asset.sha256))).toMatchObject({ state: 'ready', byteSize: 4 });
    expect(await bytes.has(asset)).toBe(true);
  });
});

describe('AT-19: perfis não misturam filas', () => {
  it('pendências de um perfil nunca aparecem nem saem pelo outro', async () => {
    const server = new FakeServer();
    const first = device(server, context.userId);
    const second = device(server, '0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    const { song } = sampleSong(context, 'Pendência do primeiro perfil');
    first.transport.faults.offline = true;
    await saveDocuments(first.db, [{ entityType: 'song', document: song }]);
    await first.sync();

    // O segundo perfil sincroniza com outra conta: não há nada dele para enviar.
    expect(await second.sync()).toMatchObject({ connection: 'idle', pushed: 0 });
    expect(server.pushLog).toEqual([]);
    expect(await second.db.songs.count()).toBe(0);
    expect(await second.db.syncOperations.count()).toBe(0);
    expect(await first.db.entityStates.where('[workspaceId+dirty]').equals([context.workspaceId, 1]).count()).toBe(1);

    // Com a conta errada conectada, o primeiro perfil não envia.
    first.transport.faults.offline = false;
    first.transport.faults.identity = 'mismatch';
    expect(await first.sync()).toMatchObject({ connection: 'identity-mismatch' });
    expect(server.pushLog).toEqual([]);
    first.transport.faults.identity = 'ok';
    await first.sync();
    expect(server.pushLog.map((push) => push.userId)).toEqual([context.userId]);
  });
});

describe('migração v4 → v5', () => {
  it('acrescenta as tabelas de sincronização sem tocar em documentos e pendências; a fila funciona depois', async () => {
    const name = `lv-migration-sync-${process.pid}-${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ songs: 'id, workspaceId', arrangements: 'id, workspaceId, songId', entityStates: 'key, [workspaceId+dirty]', meta: 'key' });
    legacy.version(2).stores({ songIndex: 'id, workspaceId', revisions: 'id, [entityType+entityId]' });
    legacy.version(3).stores({ presentationSessions: 'id, [arrangementId+status]', presentationCheckpoints: 'sessionId', outputPreferences: 'outputId' });
    legacy.version(4).stores({ assets: 'id, workspaceId, [workspaceId+sha256]', assetBlobs: 'key, workspaceId', setlists: 'id, workspaceId', offlinePackages: 'setlistId' });
    const { song } = sampleSong(context, 'Antes da sincronização');
    await legacy.table('songs').add(song);
    // Situação como a versão 4 gravava: sem os campos novos.
    await legacy.table('entityStates').add({ key: `song:${song.id}`, entityType: 'song', entityId: song.id, workspaceId: song.workspaceId, serverRevision: null, localGeneration: 4, dirty: 1, lastAckSnapshot: null, conflict: null, updatedAt: song.updatedAt });
    legacy.close();

    const db = new LocalDatabase(name);
    databases.push(db);
    await db.open();
    expect(db.verno).toBe(LOCAL_DB_VERSION);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 4, dirty: 1 });

    const server = new FakeServer();
    const coordinator = new SyncCoordinator({ storage: new DexieSyncStorage(db, { workspaceId: context.workspaceId, deviceId: crypto.randomUUID() }), transport: new FakeTransport(server), assets: new LocalAssetBytes(db, 'p'), workspaceId: context.workspaceId, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
    expect(await coordinator.syncOnce()).toMatchObject({ connection: 'idle', pushed: 1 });
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 4, dirty: 0, serverRevision: '1' });
  });
});
