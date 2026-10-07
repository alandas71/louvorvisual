import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { song } from '../../../packages/contracts/src/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaSyncStore } from '../src/modules/sync/prisma-sync-store';

const databaseUrl = process.env.DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const prisma = new PrismaClient();
const workspaceId = randomUUID();
const actorId = randomUUID();

function createSong(entityId: string, opId: string, title: string) {
  return {
    opId, entityType: 'song' as const, entityId, action: 'create' as const, baseRevision: '0', schemaVersion: 1 as const,
    payload: { ...song, id: entityId, title, workspaceId, serverRevision: null, createdBy: actorId, updatedBy: actorId },
  };
}

maybeDescribe('Prisma + SQL Server: revisão, opId e cursor', () => {
  const store = new PrismaSyncStore(prisma);
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Prova de sincronização', syncClock: { create: {} } } });
  });
  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it('mantém o resultado de opId e devolve conflito de revisão', async () => {
    const entityId = randomUUID();
    const first = createSong(entityId, randomUUID(), 'Primeira');
    const accepted = await store.apply(workspaceId, actorId, first);
    expect(accepted).toMatchObject({ status: 'accepted', revision: '1', cursor: '1' });
    await expect(store.apply(workspaceId, actorId, first)).resolves.toEqual(accepted);
    const divergent = { ...first, payload: { ...first.payload, title: 'Tentativa diferente' } };
    await expect(store.apply(workspaceId, actorId, divergent)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const stale = { ...createSong(entityId, randomUUID(), 'Stale'), action: 'update' as const, baseRevision: '0' };
    await expect(store.apply(workspaceId, actorId, stale)).resolves.toMatchObject({ status: 'conflict', currentRevision: '1' });
  });

  it('ordena duas escritas concorrentes por cursor de commit, sem lacuna no pull', async () => {
    const results = await Promise.all([
      store.apply(workspaceId, actorId, createSong(randomUUID(), randomUUID(), 'Concorrente A')),
      store.apply(workspaceId, actorId, createSong(randomUUID(), randomUUID(), 'Concorrente B')),
    ]);
    const cursors = results.map((result) => result.status === 'accepted' ? BigInt(result.cursor) : -1n).sort((a, b) => Number(a - b));
    expect(cursors[1]! - cursors[0]!).toBe(1n);
    const pull = await store.pull(workspaceId, '0', 100);
    const pulledCursors = pull.changes.map((change) => BigInt(change.cursor));
    expect(pulledCursors).toEqual([...pulledCursors].sort((a, b) => Number(a - b)));
    expect(new Set(pulledCursors.map(String)).size).toBe(pulledCursors.length);
    expect(pull.hasMore).toBe(false);
  });
});
