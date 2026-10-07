import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { SyncOperation } from '@louvorvisual/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { song } from '../../../packages/contracts/src/fixtures';
import { PrismaSyncStore } from '../src/modules/sync/prisma-sync-store';

const maybeDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const prisma = new PrismaClient();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const actorId = randomUUID();

function operation(entityId: string, action: SyncOperation['action'], baseRevision: string, workspace = workspaceId): SyncOperation {
  return { opId: randomUUID(), entityType: 'song', entityId, action, baseRevision, schemaVersion: 1, payload: { ...song, id: entityId, workspaceId: workspace } };
}

maybeDescribe('Prisma + MySQL: concorrência', () => {
  const store = new PrismaSyncStore(prisma);
  beforeAll(async () => {
    await prisma.$connect();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await prisma.workspace.create({ data: { id, name: 'Prova de concorrência', syncClock: { create: {} } } });
    }
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.$disconnect();
  });

  it('vinte escritas simultâneas são todas aceitas, com cursores contíguos', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => store.apply(workspaceId, actorId, operation(randomUUID(), 'create', '0'))));
    expect(results.map((result) => result.status)).toEqual(Array(20).fill('accepted'));
    const pull = await store.pull(workspaceId, '0', 100);
    expect(pull.changes.map((change) => change.cursor)).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));
  }, 60_000);

  it('a mesma operação repetida em paralelo é aplicada uma vez e devolve o mesmo resultado', async () => {
    const repeated = operation(randomUUID(), 'create', '0');
    const results = await Promise.all(Array.from({ length: 5 }, () => store.apply(workspaceId, actorId, repeated)));
    expect(results[0]).toMatchObject({ status: 'accepted', revision: '1' });
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(await prisma.changeEvent.count({ where: { workspaceId, entityId: repeated.entityId } })).toBe(1);
  }, 60_000);

  it('duas atualizações da mesma revisão: uma é aceita e a outra recebe conflito', async () => {
    const created = operation(randomUUID(), 'create', '0');
    await store.apply(workspaceId, actorId, created);
    const results = await Promise.all([
      store.apply(workspaceId, actorId, operation(created.entityId, 'update', '1')),
      store.apply(workspaceId, actorId, operation(created.entityId, 'update', '1')),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'conflict']);
  }, 60_000);

  it('conflito e rejeição não consomem cursor', async () => {
    const before = (await store.pull(workspaceId, '0', 100)).changes.length;
    await expect(store.apply(workspaceId, actorId, operation(randomUUID(), 'update', '3'))).resolves.toMatchObject({ status: 'rejected', code: 'ENTITY_NOT_FOUND' });
    const accepted = await store.apply(workspaceId, actorId, operation(randomUUID(), 'create', '0'));
    expect(accepted).toMatchObject({ status: 'accepted', cursor: String(before + 1) });
  });

  it('exclusão grava tombstone e restauração o remove', async () => {
    const created = operation(randomUUID(), 'create', '0', otherWorkspaceId);
    await store.apply(otherWorkspaceId, actorId, created);
    await store.apply(otherWorkspaceId, actorId, { ...created, opId: randomUUID(), action: 'delete', baseRevision: '1' });
    await store.apply(otherWorkspaceId, actorId, { ...created, opId: randomUUID(), action: 'restore', baseRevision: '2' });
    const pull = await store.pull(otherWorkspaceId, '0', 100);
    expect(pull.changes.map((change) => [change.cursor, change.action, change.document.deletedAt === null])).toEqual([
      ['1', 'create', true],
      ['2', 'delete', false],
      ['3', 'restore', true],
    ]);
  });

  it('espaço inexistente é 404, não erro interno', async () => {
    const missing = randomUUID();
    await expect(store.apply(missing, actorId, operation(randomUUID(), 'create', '0', missing))).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});
