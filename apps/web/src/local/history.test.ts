import 'fake-indexeddb/auto';
import { addSetlistItem, createSetlist, touch, type Arrangement, type Song } from '@louvorvisual/domain';
import { listOpenConflicts, SyncCoordinator } from '@louvorvisual/sync';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer, FakeTransport } from '../../../../packages/sync/src/testing';
import { LocalAssetBytes } from '@/sync/assetBytes';
import { DexieSyncStorage } from '@/sync/dexieStorage';
import type { LocalDatabase } from './db';
import { listHistory, listTrash, RecoveryError, restoreFromTrash, restoreRevision } from './history';
import { deleteSong, getEntityState, getSong, HISTORY_INTERVAL_MS, HISTORY_LIMIT, listArrangements, listRevisions, listSongIndex, saveDocuments } from './repository';
import { deleteSetlist, getSetlist } from './setlists';
import { sampleSong, testContext, testDatabase } from './testing';

const context = testContext();
const databases: LocalDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()));
});
function database() {
  const db = testDatabase();
  databases.push(db);
  return db;
}

const at = (minutes: number) => new Date(Date.parse('2026-10-06T10:00:00.000Z') + minutes * 60_000).toISOString();
const by = (minutes: number) => ({ userId: context.userId, now: at(minutes) });
const edit = (db: LocalDatabase, song: Song, title: string, minutes: number) => saveDocuments(db, [{ entityType: 'song', document: touch({ ...song, title }, by(minutes)) }], { now: at(minutes) });

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RecoveryError);
  expect((error as RecoveryError).code).toBe(code);
}

async function seeded() {
  const db = database();
  const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
  await saveDocuments(db, [
    { entityType: 'song', document: song },
    { entityType: 'arrangement', document: arrangement },
  ]);
  return { db, song, arrangement };
}

describe('histórico local', () => {
  it('guarda a versão anterior na primeira edição e no máximo uma cópia por intervalo', async () => {
    const { db, song } = await seeded();
    // Criar não gera cópia: não havia versão anterior.
    expect(await db.revisions.count()).toBe(0);
    await edit(db, song, 'Título 1', 0);
    await edit(db, song, 'Título 2', 1);
    await edit(db, song, 'Título 3', 9);
    let revisions = await listRevisions(db, 'song', song.id);
    expect(revisions.map((revision) => [revision.reason, (revision.document as Song).title])).toEqual([['edit', 'Manhã de Gratidão']]);

    // Passado o intervalo, a próxima gravação guarda o que estava antes dela.
    await edit(db, song, 'Título 4', HISTORY_INTERVAL_MS / 60_000 + 1);
    revisions = await listRevisions(db, 'song', song.id);
    expect(revisions.map((revision) => (revision.document as Song).title)).toEqual(['Título 3', 'Manhã de Gratidão']);
    // Regravar o mesmo conteúdo não gera cópia.
    const current = (await getSong(db, song.id))!;
    await saveDocuments(db, [{ entityType: 'song', document: current }], { now: at(60) });
    expect(await db.revisions.count()).toBe(2);
  });

  it('mantém no máximo o limite de cópias automáticas por documento, sem apagar as de outra origem', async () => {
    const { db, song } = await seeded();
    await db.revisions.put({ id: 'conflito', entityType: 'song', entityId: song.id, workspaceId: song.workspaceId, createdAt: at(-500), reason: 'conflict-local', document: song });
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) await edit(db, song, `Título ${index}`, index * 11);
    const revisions = await listRevisions(db, 'song', song.id);
    expect(revisions.filter((revision) => revision.reason === 'edit')).toHaveLength(HISTORY_LIMIT);
    expect(revisions.some((revision) => revision.id === 'conflito')).toBe(true);
    // Saíram as mais antigas: a mais recente guardada é a versão imediatamente anterior à última edição.
    expect((revisions[0]!.document as Song).title).toBe(`Título ${HISTORY_LIMIT + 3}`);
  });

  it('restaurar uma cópia vira a versão atual, guarda a que estava em uso e pode ser desfeito', async () => {
    const { db, song } = await seeded();
    await edit(db, song, 'Edição ruim', 0);
    const [entry] = await listHistory(db, song.workspaceId);
    expect(entry).toMatchObject({ entityType: 'song', reason: 'edit', title: 'Manhã de Gratidão', current: false });

    await restoreRevision(db, entry!.id, by(1));
    const restored = (await getSong(db, song.id))!;
    expect(restored).toMatchObject({ title: 'Manhã de Gratidão', rawLyrics: song.rawLyrics, updatedAt: at(1), deletedAt: null });
    expect((await listSongIndex(db, song.workspaceId))[0]).toMatchObject({ title: 'Manhã de Gratidão' });
    // É uma alteração local: nova geração, pendente de envio.
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ dirty: 1, localGeneration: 3 });
    const history = await listHistory(db, song.workspaceId);
    expect(history.map((item) => [item.reason, item.title, item.current])).toEqual([
      ['restore', 'Edição ruim', false],
      ['edit', 'Manhã de Gratidão', true],
    ]);
    // Desfazer a restauração: a versão que estava em uso também é recuperável.
    await restoreRevision(db, history[0]!.id, by(2));
    expect((await getSong(db, song.id))!.title).toBe('Edição ruim');
  });

  it('restaura um arranjo; com o louvor excluído, pede a lixeira primeiro; cópia ilegível não é gravada', async () => {
    const { db, song, arrangement } = await seeded();
    const shorter: Arrangement = touch({ ...arrangement, occurrences: arrangement.occurrences.slice(0, 1) }, by(0));
    await saveDocuments(db, [{ entityType: 'arrangement', document: shorter }], { now: at(0) });
    const entry = (await listHistory(db, song.workspaceId)).find((item) => item.entityType === 'arrangement')!;
    expect(entry).toMatchObject({ songTitle: 'Manhã de Gratidão' });

    await deleteSong(db, song.id, by(1));
    await expectCode(restoreRevision(db, entry.id, by(2)), 'song-missing');
    await restoreFromTrash(db, 'song', song.id, by(3));
    await restoreRevision(db, entry.id, by(4));
    expect((await listArrangements(db, song.id))[0]!.occurrences).toEqual(arrangement.occurrences);

    await db.revisions.put({ id: 'quebrada', entityType: 'song', entityId: song.id, workspaceId: song.workspaceId, createdAt: at(5), reason: 'edit', document: { ...song, title: '' } });
    const before = await getSong(db, song.id);
    await expectCode(restoreRevision(db, 'quebrada', by(6)), 'invalid');
    await expectCode(restoreRevision(db, 'não-existe', by(6)), 'not-found');
    expect(await getSong(db, song.id)).toEqual(before);
  });
});

describe('lixeira', () => {
  it('louvor excluído sai da biblioteca, fica na lixeira e volta com os arranjos', async () => {
    const { db, song, arrangement } = await seeded();
    const other = sampleSong(context, 'Fica na biblioteca');
    await saveDocuments(db, [{ entityType: 'song', document: other.song }]);
    await deleteSong(db, song.id, by(0));
    expect((await listSongIndex(db, song.workspaceId)).map((row) => row.title)).toEqual(['Fica na biblioteca']);
    expect(await listTrash(db, song.workspaceId)).toEqual([{ entityType: 'song', id: song.id, title: 'Manhã de Gratidão', deletedAt: at(0), parts: 1, pending: true, conflict: false }]);
    // A versão de antes da exclusão também ficou no histórico.
    expect((await listRevisions(db, 'song', song.id)).map((revision) => revision.reason)).toEqual(['delete']);

    await restoreFromTrash(db, 'song', song.id, by(5));
    expect(await listTrash(db, song.workspaceId)).toEqual([]);
    expect((await getSong(db, song.id))!).toMatchObject({ title: 'Manhã de Gratidão', rawLyrics: song.rawLyrics, deletedAt: null });
    expect((await listArrangements(db, song.id)).map((item) => item.id)).toEqual([arrangement.id]);
    expect((await listSongIndex(db, song.workspaceId)).map((row) => row.title).sort()).toEqual(['Fica na biblioteca', 'Manhã de Gratidão']);
    await expectCode(restoreFromTrash(db, 'song', song.id, by(6)), 'not-deleted');
  });

  it('arranjo excluído antes, por outra ação, não volta junto com o louvor', async () => {
    const { db, song, arrangement } = await seeded();
    const second: Arrangement = { ...sampleSong(context).arrangement, songId: song.id, name: 'Ensaio' };
    await saveDocuments(db, [{ entityType: 'arrangement', document: second }]);
    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...touch(second, by(-600)), deletedAt: at(-600) } }], { now: at(-600) });
    await deleteSong(db, song.id, by(0));
    await restoreFromTrash(db, 'song', song.id, by(1));
    expect((await listArrangements(db, song.id)).map((item) => item.id)).toEqual([arrangement.id]);
  });

  it('repertório excluído volta com os itens', async () => {
    const { db, arrangement } = await seeded();
    let setlist = createSetlist({ title: 'Culto de domingo', timeZone: 'America/Sao_Paulo' }, context);
    setlist = { ...setlist, items: addSetlistItem(setlist.items, arrangement.id, context.newId) };
    await saveDocuments(db, [{ entityType: 'setlist', document: setlist }]);
    await deleteSetlist(db, setlist.id, by(0));
    expect(await getSetlist(db, setlist.id)).toBeNull();
    expect(await listTrash(db, setlist.workspaceId)).toMatchObject([{ entityType: 'setlist', title: 'Culto de domingo', parts: 1 }]);
    await restoreFromTrash(db, 'setlist', setlist.id, by(1));
    expect((await getSetlist(db, setlist.id))!.items).toEqual(setlist.items);
  });

  it('em equipe: excluir e restaurar são publicados como exclusão e restauração, e chegam ao outro dispositivo', async () => {
    const server = new FakeServer();
    let tick = 0;
    const device = () => {
      const db = database();
      const storage = new DexieSyncStorage(db, { workspaceId: context.workspaceId, deviceId: crypto.randomUUID() });
      const coordinator = new SyncCoordinator({ storage, transport: new FakeTransport(server, context.userId), assets: new LocalAssetBytes(db, 'perfil'), workspaceId: context.workspaceId, now: () => at(100 + (tick += 1)), newId: () => crypto.randomUUID() });
      return { db, storage, sync: () => coordinator.syncOnce() };
    };
    const a = device();
    const b = device();
    const { song, arrangement } = sampleSong(context, 'Manhã de Gratidão');
    await saveDocuments(a.db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    await a.sync();
    await b.sync();

    await deleteSong(a.db, song.id, by(0));
    await a.sync();
    await b.sync();
    expect(await getSong(b.db, song.id)).toBeNull();
    // A exclusão recebida da equipe também aparece na lixeira de B, já confirmada.
    expect(await listTrash(b.db, context.workspaceId)).toMatchObject([{ id: song.id, pending: false, parts: 1 }]);

    await restoreFromTrash(b.db, 'song', song.id, by(5));
    expect(await b.sync()).toMatchObject({ pushed: 2, conflictsOpened: 0 });
    expect(server.pushLog.flatMap((push) => push.operations).slice(-2).map((operation) => [operation.entityType, operation.action])).toEqual([
      ['song', 'restore'],
      ['arrangement', 'restore'],
    ]);
    await a.sync();
    expect((await getSong(a.db, song.id))!.title).toBe('Manhã de Gratidão');
    expect(await listArrangements(a.db, song.id)).toHaveLength(1);
    expect(await listOpenConflicts(a.storage)).toEqual([]);
  });

  it('item em conflito aberto não é restaurado pela lixeira', async () => {
    const { db, song } = await seeded();
    await deleteSong(db, song.id, by(0));
    const state = (await getEntityState(db, 'song', song.id))!;
    await db.entityStates.put({ ...state, conflict: 'conflito-aberto' });
    expect(await listTrash(db, song.workspaceId)).toMatchObject([{ conflict: true }]);
    await expectCode(restoreFromTrash(db, 'song', song.id, by(1)), 'in-conflict');
    expect((await db.songs.get(song.id))!.deletedAt).toBe(at(0));
  });
});
