import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase, UPGRADES } from './db';
import { classifyOpenError, ensureCompatible, guardConnection, LOCAL_DB_MIN_READER, LocalOpenError, SUPERSEDE_GRACE_MS } from './open';
import { getEntityState, listSongIndex, saveDocuments } from './repository';
import { entityStateKey, LOCAL_DB_VERSION, type LocalEntityState } from './schema';
import { sampleSong, testContext } from './testing';

const names: string[] = [];
function freshName() {
  const name = `lv-migration-${process.pid}-${Date.now()}-${names.length}`;
  names.push(name);
  return name;
}
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
});

/** Banco como a versão 1 o deixava: sem índice de busca e sem revisões. */
async function createVersion1(name: string) {
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    songs: 'id, workspaceId',
    arrangements: 'id, workspaceId, songId',
    entityStates: 'key, [workspaceId+dirty]',
    meta: 'key',
  });
  const context = testContext();
  const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
  const deleted = { ...sampleSong(context, 'Canção Antiga').song, deletedAt: context.now };
  const state: LocalEntityState = {
    key: entityStateKey('song', song.id),
    entityType: 'song',
    entityId: song.id,
    workspaceId: song.workspaceId,
    serverRevision: null,
    localGeneration: 3,
    dirty: 1,
    lastAckSnapshot: null,
    conflict: null,
    updatedAt: song.updatedAt,
  };
  await legacy.table('songs').bulkAdd([song, deleted]);
  await legacy.table('arrangements').add(arrangement);
  await legacy.table('entityStates').add(state);
  legacy.close();
  return { song, arrangement, deleted };
}

describe('migrações do banco local', () => {
  it('banco novo abre na versão atual com todas as tabelas', async () => {
    const db = new LocalDatabase(freshName());
    await db.open();
    expect(db.verno).toBe(LOCAL_DB_VERSION);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      'arrangements',
      'assetBlobs',
      'assets',
      'editLeases',
      'entityStates',
      'importMap',
      'meta',
      'offlinePackages',
      'outputPreferences',
      'presentationCheckpoints',
      'presentationSessions',
      'revisions',
      'setlists',
      'songIndex',
      'songs',
      'syncConflicts',
      'syncMeta',
      'syncOperations',
      'syncStaging',
      'themes',
    ]);
    db.close();
  });

  it('v1 → atual preserva documentos e pendências e reconstrói o índice de busca', async () => {
    const name = freshName();
    const { song, arrangement, deleted } = await createVersion1(name);

    const db = new LocalDatabase(name);
    await db.open();
    expect(db.verno).toBe(LOCAL_DB_VERSION);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await db.arrangements.get(arrangement.id)).toEqual(arrangement);
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 3, dirty: 1 });

    expect(await db.songIndex.count()).toBe(2);
    expect(await listSongIndex(db, song.workspaceId)).toMatchObject([{ id: song.id, title: 'Manhã de Gratidão', titleKey: 'manha de gratidao' }]);
    expect((await db.songIndex.get(deleted.id))?.deletedAt).toBe(deleted.deletedAt);
    expect(await db.revisions.count()).toBe(0);
    db.close();
  });

  it('v2 → v3 acrescenta as tabelas de sessão sem tocar em louvores, pendências, índice e revisões', async () => {
    const name = freshName();
    const legacy = new Dexie(name);
    legacy.version(1).stores({ songs: 'id, workspaceId', arrangements: 'id, workspaceId, songId', entityStates: 'key, [workspaceId+dirty]', meta: 'key' });
    legacy.version(2).stores({ songIndex: 'id, workspaceId', revisions: 'id, [entityType+entityId]' });
    const { song, arrangement } = sampleSong(testContext(), 'Antes do Motor');
    await legacy.table('songs').add(song);
    await legacy.table('arrangements').add(arrangement);
    await legacy.table('songIndex').add({ id: song.id, workspaceId: song.workspaceId, marcador: 'intacto' });
    await legacy.table('revisions').add({ id: 'rev-1', entityType: 'song', entityId: song.id, document: song });
    await legacy.table('entityStates').add({ key: entityStateKey('arrangement', arrangement.id), workspaceId: song.workspaceId, dirty: 1, localGeneration: 9 });
    legacy.close();

    const db = new LocalDatabase(name);
    await db.open();
    expect(db.verno).toBe(LOCAL_DB_VERSION);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await db.arrangements.get(arrangement.id)).toEqual(arrangement);
    // O índice não é reconstruído de novo: a migração v2 não se repete.
    expect(await db.songIndex.get(song.id)).toMatchObject({ marcador: 'intacto' });
    expect(await db.revisions.count()).toBe(1);
    expect(await getEntityState(db, 'arrangement', arrangement.id)).toMatchObject({ localGeneration: 9, dirty: 1 });
    expect(await db.presentationSessions.count()).toBe(0);
    expect(await db.presentationCheckpoints.count()).toBe(0);
    expect(await db.outputPreferences.count()).toBe(0);
    db.close();
  });

  it('v3 → v4 acrescenta áudio, repertórios e pacotes sem tocar em arranjos, sessões e checkpoints', async () => {
    const name = freshName();
    const legacy = new Dexie(name);
    legacy.version(1).stores({ songs: 'id, workspaceId', arrangements: 'id, workspaceId, songId', entityStates: 'key, [workspaceId+dirty]', meta: 'key' });
    legacy.version(2).stores({ songIndex: 'id, workspaceId', revisions: 'id, [entityType+entityId]' });
    legacy.version(3).stores({ presentationSessions: 'id, [arrangementId+status]', presentationCheckpoints: 'sessionId', outputPreferences: 'outputId' });
    const { song, arrangement } = sampleSong(testContext(), 'Antes do Áudio');
    // Sessão gravada pela etapa anterior: o snapshot ainda tinha `audio: null`.
    const session = { id: 'sessao-antiga', workspaceId: song.workspaceId, songId: song.id, arrangementId: arrangement.id, status: 'active', createdAt: song.createdAt, snapshot: { id: 'sessao-antiga', audio: null }, baseArrangement: arrangement };
    const checkpoint = { sessionId: 'sessao-antiga', savedAt: song.createdAt, checkpoint: { sessionId: 'sessao-antiga', status: 'paused', elapsedInSlideMs: 1200 } };
    await legacy.table('songs').add(song);
    await legacy.table('arrangements').add(arrangement);
    await legacy.table('presentationSessions').add(session);
    await legacy.table('presentationCheckpoints').add(checkpoint);
    await legacy.table('outputPreferences').add({ outputId: 'public', rotation: 90 });
    await legacy.table('entityStates').add({ key: entityStateKey('arrangement', arrangement.id), workspaceId: song.workspaceId, dirty: 1, localGeneration: 5 });
    legacy.close();

    const db = new LocalDatabase(name);
    await db.open();
    expect(db.verno).toBe(LOCAL_DB_VERSION);
    expect(await db.arrangements.get(arrangement.id)).toEqual(arrangement);
    expect(await db.presentationSessions.get('sessao-antiga')).toEqual(session);
    expect(await db.presentationCheckpoints.get('sessao-antiga')).toEqual(checkpoint);
    expect(await db.outputPreferences.get('public')).toEqual({ outputId: 'public', rotation: 90 });
    expect(await getEntityState(db, 'arrangement', arrangement.id)).toMatchObject({ localGeneration: 5, dirty: 1 });
    for (const table of [db.assets, db.assetBlobs, db.setlists, db.offlinePackages]) expect(await table.count()).toBe(0);
    db.close();
  });

  it('depois de migrar, novas gravações continuam a geração anterior', async () => {
    const name = freshName();
    const { song } = await createVersion1(name);
    const db = new LocalDatabase(name);
    await saveDocuments(db, [{ entityType: 'song', document: { ...song, title: 'Manhã Nova' } }]);
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 4, dirty: 1 });
    db.close();
  });

  it('reabrir o banco já migrado não repete a migração nem perde dados', async () => {
    const name = freshName();
    const { song } = await createVersion1(name);
    const first = new LocalDatabase(name);
    await first.songIndex.delete(song.id);
    first.close();
    const second = new LocalDatabase(name);
    expect(await second.songIndex.get(song.id)).toBeUndefined();
    expect(await second.songs.get(song.id)).toEqual(song);
    second.close();
  });
});

/** Banco como a versão 5 o deixava, com conteúdo em todas as áreas que a v6 toca ou acompanha. */
async function createVersion5(name: string) {
  const legacy = new Dexie(name);
  legacy.version(1).stores({ songs: 'id, workspaceId', arrangements: 'id, workspaceId, songId', entityStates: 'key, [workspaceId+dirty]', meta: 'key' });
  legacy.version(2).stores({ songIndex: 'id, workspaceId', revisions: 'id, [entityType+entityId]' });
  legacy.version(3).stores({ presentationSessions: 'id, [arrangementId+status]', presentationCheckpoints: 'sessionId', outputPreferences: 'outputId' });
  legacy.version(4).stores({ assets: 'id, workspaceId, [workspaceId+sha256]', assetBlobs: 'key, workspaceId', setlists: 'id, workspaceId', offlinePackages: 'setlistId' });
  legacy.version(5).stores({ themes: 'id, workspaceId', syncOperations: 'opId, key', syncConflicts: 'id, key, status', syncMeta: 'key', syncStaging: 'key', editLeases: 'id, key' });
  const context = testContext();
  const { song, arrangement } = sampleSong(context, 'Antes dos Pacotes');
  const state: LocalEntityState = { key: entityStateKey('song', song.id), entityType: 'song', entityId: song.id, workspaceId: song.workspaceId, serverRevision: '4', localGeneration: 7, dirty: 1, lastAckSnapshot: song, conflict: null, updatedAt: song.updatedAt };
  const profile = { key: 'profile', kind: 'personal', profileId: 'p', workspaceId: song.workspaceId, userId: context.userId, deviceId: 'd', createdAt: context.now };
  // Uma cópia com o espaço gravado e outra, mais antiga, sem o campo.
  const revisions = [
    { id: 'rev-com', entityType: 'song', entityId: song.id, workspaceId: song.workspaceId, createdAt: context.now, reason: 'regenerate', document: song },
    { id: 'rev-sem', entityType: 'arrangement', entityId: arrangement.id, createdAt: context.now, reason: 'conflict-local', document: arrangement },
  ];
  const operation = { opId: 'op-1', key: state.key, entityType: 'song', entityId: song.id, action: 'update', baseRevision: '4', capturedGeneration: 7, payload: song, createdAt: context.now, attempts: 1, firstSentAt: context.now, lastAttemptAt: context.now, lastError: null, status: 'queued' };
  const checkpoint = { sessionId: 'sessao', savedAt: context.now, checkpoint: { sessionId: 'sessao', status: 'paused', elapsedInSlideMs: 800 } };
  await legacy.table('songs').add(song);
  await legacy.table('arrangements').add(arrangement);
  await legacy.table('songIndex').add({ id: song.id, workspaceId: song.workspaceId, marcador: 'intacto' });
  await legacy.table('entityStates').add(state);
  await legacy.table('meta').add(profile);
  await legacy.table('revisions').bulkAdd(revisions);
  await legacy.table('syncOperations').add(operation);
  await legacy.table('syncMeta').add({ key: 'sync', cursor: '41', needsBootstrap: false, deviceId: 'd', suspended: null, lastSyncAt: context.now });
  await legacy.table('presentationCheckpoints').add(checkpoint);
  await legacy.table('assetBlobs').add({ key: 'k', workspaceId: song.workspaceId, sha256: 'a'.repeat(64), byteSize: 3, blob: new Blob(['abc']), state: 'ready' });
  legacy.close();
  return { song, arrangement, state, profile, operation, checkpoint };
}

/** Versão do banco gravada no navegador, sem passar pelo Dexie (que multiplica por 10). */
function storedVersion(name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const { version } = request.result;
      request.result.close();
      resolve(version / 10);
    };
  });
}

describe('migração v5 → v6 (pacotes e histórico)', () => {
  it('acrescenta o mapa de importação e o índice das cópias sem tocar em documentos, pendências, fila, cursor, sessões e mídia', async () => {
    const name = freshName();
    const { song, arrangement, state, profile, operation, checkpoint } = await createVersion5(name);
    const db = new LocalDatabase(name);
    await db.open();
    expect(db.verno).toBe(6);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await db.arrangements.get(arrangement.id)).toEqual(arrangement);
    expect(await db.entityStates.get(state.key)).toEqual(state);
    expect(await db.meta.get('profile')).toEqual(profile);
    expect(await db.syncOperations.get('op-1')).toEqual(operation);
    expect(await db.syncMeta.get('sync')).toMatchObject({ cursor: '41' });
    expect(await db.presentationCheckpoints.get('sessao')).toEqual(checkpoint);
    expect(await db.songIndex.get(song.id)).toMatchObject({ marcador: 'intacto' });
    expect(await (await db.assetBlobs.get('k'))!.blob.text()).toBe('abc');
    expect(await db.importMap.count()).toBe(0);
    // A cópia antiga sem espaço passa a aparecer na consulta por espaço; a outra não muda.
    const byWorkspace = await db.revisions.where('workspaceId').equals(song.workspaceId).toArray();
    expect(byWorkspace.map((revision) => revision.id).sort()).toEqual(['rev-com', 'rev-sem']);
    expect((await db.revisions.get('rev-com'))!.document).toEqual(song);
    db.close();
  });

  it('reinício durante a migração: a troca de versão é desfeita por inteiro e a próxima abertura conclui', async () => {
    const name = freshName();
    const { song, state, operation } = await createVersion5(name);

    // A conversão da v6 roda de verdade e o processo "morre" antes de a transação confirmar.
    const interrupted = new LocalDatabase(name, {
      ...UPGRADES,
      6: async (transaction) => {
        await UPGRADES[6]!(transaction);
        await transaction.table('songs').clear();
        throw new Error('aba fechada no meio da migração');
      },
    });
    await expect(interrupted.open()).rejects.toThrow();
    interrupted.close();

    // O banco continua na versão 5, inteiro: nada da migração parcial ficou.
    expect(await storedVersion(name)).toBe(5);
    const still = new Dexie(name);
    await still.open();
    expect(still.tables.map((table) => table.name)).not.toContain('importMap');
    expect(await still.table('songs').get(song.id)).toEqual(song);
    expect(await still.table('revisions').get('rev-sem')).not.toHaveProperty('workspaceId');
    expect(await still.table('syncOperations').get('op-1')).toEqual(operation);
    still.close();

    // Reabrir com o código normal migra e continua de onde estava.
    const db = new LocalDatabase(name);
    await db.open();
    expect(db.verno).toBe(6);
    expect(await storedVersion(name)).toBe(6);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await db.entityStates.get(state.key)).toEqual(state);
    expect((await db.revisions.get('rev-sem'))!.workspaceId).toBe(song.workspaceId);
    await saveDocuments(db, [{ entityType: 'song', document: { ...song, title: 'Depois da migração' } }]);
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 8, dirty: 1, serverRevision: '4' });
    db.close();
  });

  it('janela antiga em apresentação segura a migração; a nova espera e conclui quando ela fecha', async () => {
    const name = freshName();
    const { song } = await createVersion5(name);
    const old = new Dexie(name);
    await old.open();
    const events: string[] = [];
    // O mesmo tratamento que o aplicativo instala, aqui sobre a conexão antiga.
    guardConnection(old as unknown as LocalDatabase, { isPresenting: () => true, onSuperseded: () => events.push('superseded'), onBlocked: () => events.push('old-blocked') });

    const db = new LocalDatabase(name);
    guardConnection(db, { isPresenting: () => false, onSuperseded: () => events.push('new-superseded'), onBlocked: () => events.push('blocked') });
    let opened = false;
    const opening = db.open().then(() => (opened = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // A apresentação continua lendo e gravando no banco antigo; a migração não começou.
    expect(opened).toBe(false);
    expect(events).toEqual(['blocked']);
    expect(old.isOpen()).toBe(true);
    await old.table('presentationCheckpoints').put({ sessionId: 'sessao', savedAt: 'agora', checkpoint: { status: 'running' } });
    expect(old.verno).toBe(5);

    old.close();
    await opening;
    expect(db.verno).toBe(6);
    expect(await db.songs.get(song.id)).toEqual(song);
    expect(await db.presentationCheckpoints.get('sessao')).toMatchObject({ savedAt: 'agora' });
    db.close();
  });

  it('janela antiga fora de apresentação entrega a conexão: avisa, espera a gravação pendente e fecha', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const name = freshName();
      await createVersion5(name);
      const old = new Dexie(name);
      await old.open();
      const events: string[] = [];
      guardConnection(old as unknown as LocalDatabase, { isPresenting: () => false, onSuperseded: () => events.push('superseded'), onBlocked: () => undefined });
      const db = new LocalDatabase(name);
      const opening = db.open();
      await vi.waitFor(() => expect(events).toEqual(['superseded']));
      expect(old.isOpen()).toBe(true);
      await vi.advanceTimersByTimeAsync(SUPERSEDE_GRACE_MS);
      expect(old.isOpen()).toBe(false);
      await opening;
      expect(db.verno).toBe(6);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('abertura segura', () => {
  it('grava o marcador de formato e não o rebaixa', async () => {
    const db = new LocalDatabase(freshName());
    await ensureCompatible(db);
    expect(await db.table('meta').get('schema')).toEqual({ key: 'schema', version: LOCAL_DB_VERSION, minReader: LOCAL_DB_MIN_READER });
    // Dados gravados por uma versão seguinte que ainda aceita este código.
    await db.table('meta').put({ key: 'schema', version: LOCAL_DB_VERSION + 1, minReader: LOCAL_DB_VERSION });
    await ensureCompatible(db);
    expect(await db.table('meta').get('schema')).toMatchObject({ version: LOCAL_DB_VERSION + 1 });
    db.close();
  });

  it('dados de uma versão mais nova, incompatível com este código: recusa abrir para escrita e não altera nada', async () => {
    const db = new LocalDatabase(freshName());
    const { song } = sampleSong(testContext(), 'Do futuro');
    await saveDocuments(db, [{ entityType: 'song', document: song }]);
    await db.table('meta').put({ key: 'schema', version: LOCAL_DB_VERSION + 3, minReader: LOCAL_DB_VERSION + 2 });
    const error = await ensureCompatible(db).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalOpenError);
    expect(error).toMatchObject({ code: 'newer-data' });
    expect((error as Error).message).toContain('Nada foi alterado');
    expect(await db.table('meta').get('schema')).toMatchObject({ version: LOCAL_DB_VERSION + 3 });
    expect(await db.songs.get(song.id)).toEqual(song);
    db.close();
  });

  it('classifica as falhas de abertura em algo que o operador pode resolver', () => {
    const named = (name: string, inner?: unknown) => Object.assign(new Error(name), { name, inner });
    expect(classifyOpenError(named('VersionError')).code).toBe('newer-data');
    expect(classifyOpenError(named('OpenFailedError', named('QuotaExceededError'))).code).toBe('quota');
    expect(classifyOpenError(named('MissingAPIError')).code).toBe('unavailable');
    expect(classifyOpenError(named('OpenFailedError', named('UnknownError'))).code).toBe('corrupted');
    expect(classifyOpenError(named('UnknownError')).message).toContain('Nada foi apagado');
  });
});
