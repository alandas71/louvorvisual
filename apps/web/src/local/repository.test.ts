import 'fake-indexeddb/auto';
import { setOccurrenceDuration, touch } from '@louvorvisual/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalDatabase } from './db';
import {
  countPending,
  deleteSong,
  ensureProfile,
  getEntityState,
  getSong,
  listArrangements,
  listRevisions,
  listSongIndex,
  LocalSaveError,
  MAX_DOCUMENT_BYTES,
  saveDocuments,
} from './repository';
import { sampleSong, SAMPLE_LYRICS, testContext, testDatabase } from './testing';

let db: LocalDatabase;
afterEach(async () => {
  await db?.delete();
});

async function saveError(promise: Promise<unknown>): Promise<LocalSaveError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalSaveError);
  return error as LocalSaveError;
}

describe('saveDocuments', () => {
  it('grava louvor e arranjo com a pendência de cada um', async () => {
    db = testDatabase();
    const { song, arrangement } = sampleSong();
    const saved = await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);

    expect(saved.map((item) => item.localGeneration)).toEqual([1, 1]);
    expect((await getSong(db, song.id))?.rawLyrics).toBe(SAMPLE_LYRICS);
    expect(await listArrangements(db, song.id)).toEqual([arrangement]);
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ dirty: 1, localGeneration: 1, serverRevision: null, workspaceId: song.workspaceId });
    expect(await getEntityState(db, 'arrangement', arrangement.id)).toMatchObject({ dirty: 1, localGeneration: 1 });
    expect(await countPending(db, song.workspaceId)).toBe(2);
  });

  it('cada gravação aumenta a geração local do documento alterado, e só dele', async () => {
    db = testDatabase();
    const { song, arrangement } = sampleSong();
    await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    const edited = setOccurrenceDuration(arrangement, [arrangement.occurrences[0]!.id], 8000);
    if (!edited.ok) throw new Error(edited.error);
    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...arrangement, ...edited.structure } }]);

    expect((await getEntityState(db, 'arrangement', arrangement.id))?.localGeneration).toBe(2);
    expect((await getEntityState(db, 'song', song.id))?.localGeneration).toBe(1);
    expect((await listArrangements(db, song.id))[0]?.occurrences.map((item) => item.durationMs)).toEqual([8000, null, null]);
  });

  it('falha ao marcar a pendência desfaz também o documento', async () => {
    db = testDatabase();
    const { song, arrangement } = sampleSong();
    db.entityStates.hook('creating', () => {
      throw new Error('falha injetada');
    });

    const error = await saveError(
      saveDocuments(db, [
        { entityType: 'song', document: song },
        { entityType: 'arrangement', document: arrangement },
      ]),
    );
    expect(error.code).toBe('storage');
    expect(await db.songs.count()).toBe(0);
    expect(await db.arrangements.count()).toBe(0);
    expect(await db.songIndex.count()).toBe(0);
    expect(await db.entityStates.count()).toBe(0);
  });

  it('falha no segundo documento não deixa o primeiro gravado', async () => {
    db = testDatabase();
    const { song, arrangement } = sampleSong();
    db.arrangements.hook('creating', () => {
      throw new Error('falha injetada');
    });
    await saveError(
      saveDocuments(db, [
        { entityType: 'song', document: song },
        { entityType: 'arrangement', document: arrangement },
      ]),
    );
    expect(await db.songs.count()).toBe(0);
    expect(await db.entityStates.count()).toBe(0);
  });

  it('falta de espaço preserva a versão anterior e informa o motivo', async () => {
    db = testDatabase();
    const { song } = sampleSong();
    await saveDocuments(db, [{ entityType: 'song', document: song }]);
    db.songs.hook('updating', () => {
      throw new DOMException('sem espaço', 'QuotaExceededError');
    });

    const error = await saveError(saveDocuments(db, [{ entityType: 'song', document: { ...song, title: 'Título novo' } }]));
    expect(error.code).toBe('quota');
    expect((await getSong(db, song.id))?.title).toBe('Em União');
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ localGeneration: 1 });
    expect((await listSongIndex(db, song.workspaceId))[0]?.title).toBe('Em União');
  });

  it('recusa documento inválido antes de abrir a transação', async () => {
    db = testDatabase();
    const { song, arrangement } = sampleSong();
    const zero = { ...arrangement, occurrences: arrangement.occurrences.map((item) => ({ ...item, durationMs: 0 })) };

    expect((await saveError(saveDocuments(db, [{ entityType: 'song', document: { ...song, title: '  ' } }]))).code).toBe('invalid-document');
    expect(
      (
        await saveError(
          saveDocuments(db, [
            { entityType: 'song', document: song },
            { entityType: 'arrangement', document: zero },
          ]),
        )
      ).code,
    ).toBe('invalid-document');
    expect(await db.songs.count()).toBe(0);
  });

  it('recusa agregado acima de 1 MiB sem marcar como pronto para sincronizar', async () => {
    db = testDatabase();
    const { song } = sampleSong();
    const error = await saveError(saveDocuments(db, [{ entityType: 'song', document: { ...song, notes: 'x'.repeat(MAX_DOCUMENT_BYTES) } }]));
    expect(error.code).toBe('document-too-large');
    expect(await countPending(db, song.workspaceId)).toBe(0);
  });

  it('guarda a revisão anterior na mesma transação', async () => {
    db = testDatabase();
    const context = testContext();
    const { song, arrangement } = sampleSong(context);
    await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    const revision = {
      id: context.newId(),
      entityType: 'arrangement' as const,
      entityId: arrangement.id,
      workspaceId: arrangement.workspaceId,
      createdAt: '2026-10-05T13:00:00.000Z',
      reason: 'regenerate' as const,
      document: arrangement,
    };
    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...arrangement, occurrences: [] } }], { revisions: [revision] });

    expect((await listArrangements(db, song.id))[0]?.occurrences).toEqual([]);
    expect((await listRevisions(db, 'arrangement', arrangement.id))[0]?.document).toEqual(arrangement);
  });
});

describe('biblioteca local', () => {
  it('índice de busca acompanha criação e edição do louvor', async () => {
    db = testDatabase();
    const context = testContext();
    const { song } = sampleSong(context);
    await saveDocuments(db, [{ entityType: 'song', document: song }]);
    await saveDocuments(db, [{ entityType: 'song', document: touch({ ...song, title: 'Canção Nova' }, { userId: context.userId, now: '2026-10-05T13:00:00.000Z' }) }]);

    expect(await listSongIndex(db, song.workspaceId)).toMatchObject([{ id: song.id, title: 'Canção Nova', titleKey: 'cancao nova', artistKey: 'coral da vila' }]);
    expect(await listSongIndex(db, crypto.randomUUID())).toEqual([]);
  });

  it('excluir cria tombstones pendentes; nada é apagado fisicamente', async () => {
    db = testDatabase();
    const context = testContext();
    const { song, arrangement } = sampleSong(context);
    await saveDocuments(db, [
      { entityType: 'song', document: song },
      { entityType: 'arrangement', document: arrangement },
    ]);
    await deleteSong(db, song.id, { userId: context.userId, now: '2026-10-06T00:00:00.000Z' });

    expect(await getSong(db, song.id)).toBeNull();
    expect(await listSongIndex(db, song.workspaceId)).toEqual([]);
    expect(await listArrangements(db, song.id)).toEqual([]);
    expect((await db.songs.get(song.id))?.deletedAt).toBe('2026-10-06T00:00:00.000Z');
    expect((await db.arrangements.get(arrangement.id))?.deletedAt).toBe('2026-10-06T00:00:00.000Z');
    expect(await getEntityState(db, 'song', song.id)).toMatchObject({ dirty: 1, localGeneration: 2 });
  });

  it('o perfil do dispositivo é criado uma vez e reaproveitado', async () => {
    db = testDatabase();
    const first = await ensureProfile(db, () => crypto.randomUUID(), '2026-10-05T12:00:00.000Z');
    const second = await ensureProfile(db, () => crypto.randomUUID(), '2026-10-06T12:00:00.000Z');
    expect(second).toEqual(first);
    expect(new Set([first.profileId, first.workspaceId, first.userId, first.deviceId]).size).toBe(4);
  });
});
