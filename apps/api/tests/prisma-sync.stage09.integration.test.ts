import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { SyncOperation } from '@louvorvisual/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arrangement, asset, song } from '../../../packages/contracts/src/fixtures';
import { PrismaSyncStore } from '../src/modules/sync/prisma-sync-store';

const maybeDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const prisma = new PrismaClient(); const workspaceId = randomUUID(); const otherWorkspaceId = randomUUID(); const actorId = randomUUID();
function songOp(id = randomUUID(), action: SyncOperation['action'] = 'create', baseRevision = '0'): SyncOperation { return { opId: randomUUID(), entityType: 'song', entityId: id, action, baseRevision, schemaVersion: 1, payload: { ...song, id, workspaceId, title: `${song.title} ${id}` } }; }

maybeDescribe('MySQL: bootstrap, referências e retenção da etapa 09', () => {
  const store = new PrismaSyncStore(prisma);
  beforeAll(async () => { await prisma.$connect(); for (const id of [workspaceId, otherWorkspaceId]) await prisma.workspace.create({ data: { id, name: 'Etapa 09', syncClock: { create: {} } } }); });
  afterAll(async () => { await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }); await prisma.$disconnect(); });

  it('mantém bootstrap congelado enquanto uma escrita posterior ganha cursor no pull', async () => {
    await store.apply(workspaceId, actorId, songOp()); const bootstrap = await store.bootstrap(workspaceId, 100); const late = songOp(); await store.apply(workspaceId, actorId, late);
    expect(bootstrap.documents.map((document) => document.entityId)).not.toContain(late.entityId);
    expect(await store.pull(workspaceId, bootstrap.cutCursor, 100)).toMatchObject({ changes: [expect.objectContaining({ entityId: late.entityId })] });
  });

  it('recusa arranjo que referencia asset de outro workspace', async () => {
    const songId = randomUUID(); await store.apply(workspaceId, actorId, songOp(songId)); const foreignAssetId = randomUUID();
    const foreignAsset: SyncOperation = { opId: randomUUID(), entityType: 'asset', entityId: foreignAssetId, action: 'create', baseRevision: '0', schemaVersion: 1, payload: { ...asset, id: foreignAssetId, workspaceId: otherWorkspaceId } };
    await store.apply(otherWorkspaceId, actorId, foreignAsset);
    const arrangementId = randomUUID(); const attempt: SyncOperation = { opId: randomUUID(), entityType: 'arrangement', entityId: arrangementId, action: 'create', baseRevision: '0', schemaVersion: 1, payload: { ...arrangement, id: arrangementId, workspaceId, songId, audioBindings: arrangement.audioBindings.map((binding) => ({ ...binding, assetId: foreignAssetId })) } };
    await expect(store.apply(workspaceId, actorId, attempt)).resolves.toMatchObject({ status: 'rejected', code: 'DEPENDENCY_NOT_READY' });
  });

  it('faz cursor expirado explícito sem permitir pull parcial', async () => {
    await prisma.workspaceSyncClock.update({ where: { workspaceId }, data: { minCursor: 1n } });
    await expect(store.pull(workspaceId, '0', 100)).rejects.toMatchObject({ statusCode: 410, code: 'CURSOR_EXPIRED' });
  });
});
