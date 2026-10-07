import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { song } from '../../../packages/contracts/src/fixtures';
import { PrismaRetentionService } from '../src/modules/retention/prisma-retention-service';
import { PrismaSyncStore } from '../src/modules/sync/prisma-sync-store';

const maybeDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const prisma = new PrismaClient(); const workspaceId = randomUUID(); const actorId = randomUUID();

maybeDescribe('PrismaRetentionService', () => {
  beforeAll(async () => { await prisma.$connect(); await prisma.workspace.create({ data: { id: workspaceId, name: 'Retenção', syncClock: { create: {} } } }); });
  afterAll(async () => { await prisma.workspace.delete({ where: { id: workspaceId } }); await prisma.$disconnect(); });

  it('expira eventos e revisões sem devolver pull parcial', async () => {
    const entityId = randomUUID(); const operation = { opId: randomUUID(), entityType: 'song' as const, entityId, action: 'create' as const, baseRevision: '0', schemaVersion: 1 as const, payload: { ...song, id: entityId, workspaceId } };
    const store = new PrismaSyncStore(prisma); await store.apply(workspaceId, actorId, operation);
    const old = new Date(Date.now() - 181 * 86_400_000);
    await prisma.$executeRaw`UPDATE [change_events] SET [createdAt] = ${old} WHERE [workspaceId] = ${workspaceId}`;
    await prisma.$executeRaw`UPDATE [content_revisions] SET [createdAt] = ${old} WHERE [workspaceId] = ${workspaceId}`;
    const result = await new PrismaRetentionService(prisma).run({ trashDays: 30, syncDays: 180, sessionDays: 30 });
    expect(result.expiredEvents).toBe(1); expect(result.expiredRevisions).toBe(1);
    await expect(store.pull(workspaceId, '0', 50)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED', statusCode: 410 });
    expect(await store.bootstrap(workspaceId, 50)).toMatchObject({ documents: [expect.objectContaining({ entityId })] });
  });
});
