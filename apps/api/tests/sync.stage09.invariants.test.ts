import { randomUUID } from 'node:crypto';
import type { SyncOperation } from '@louvorvisual/contracts';
import { describe, expect, it } from 'vitest';
import { song } from '../../../packages/contracts/src/fixtures';
import { InMemorySyncStore } from '../src/modules/sync/in-memory-sync-store';

const workspaceId = '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d';
const actorId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const deviceId = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
function op(entityId: SyncOperation['entityId'] = randomUUID() as SyncOperation['entityId'], action: SyncOperation['action'] = 'create', baseRevision = '0', opId: SyncOperation['opId'] = randomUUID() as SyncOperation['opId']): SyncOperation {
  return { opId, entityType: 'song', entityId, action, baseRevision, schemaVersion: 1, payload: { ...song, id: entityId, workspaceId, title: `${song.title} ${entityId}` } };
}

describe('AT-11, AT-12, AT-13 e AT-23: invariantes de sincronização', () => {
  it('AT-11: duas escritas da mesma revisão têm um vencedor e uma variante conflitante recuperável', async () => {
    const store = new InMemorySyncStore(); const created = op(); await store.apply(workspaceId, actorId, created, deviceId);
    const [a, b] = await Promise.all([store.apply(workspaceId, actorId, op(created.entityId, 'update', '1'), deviceId), store.apply(workspaceId, actorId, op(created.entityId, 'update', '1'), deviceId)]);
    expect([a.status, b.status].sort()).toEqual(['accepted', 'conflict']);
    const conflict = [a, b].find((result) => result.status === 'conflict');
    expect(conflict).toMatchObject({ currentRevision: '2', document: { id: created.entityId } });
    expect((await store.revisions!(workspaceId, 'song', created.entityId, 10)).map((revision) => revision.revision)).toEqual(['2', '1']);
  });

  it('AT-12: repetir a tentativa após perder a resposta não cria revisão nem evento extra', async () => {
    const store = new InMemorySyncStore(); const pending = op(); const committed = await store.apply(workspaceId, actorId, pending, deviceId);
    expect(await store.apply(workspaceId, actorId, pending, deviceId)).toEqual(committed);
    const pull = await store.pull(workspaceId, '0', 100);
    expect(pull.changes).toHaveLength(1); expect(pull.changes[0]).toMatchObject({ revision: '1', cursor: '1' });
  });

  it('AT-13: edição offline posterior a tombstone vira conflito com a versão excluída, sem ressuscitar o ID', async () => {
    const store = new InMemorySyncStore(); const created = op(); await store.apply(workspaceId, actorId, created, deviceId);
    const deleted = await store.apply(workspaceId, actorId, op(created.entityId, 'delete', '1'), deviceId); expect(deleted).toMatchObject({ status: 'accepted', revision: '2' });
    const staleEdit = await store.apply(workspaceId, actorId, op(created.entityId, 'update', '1'), deviceId);
    expect(staleEdit).toMatchObject({ status: 'conflict', currentRevision: '2', document: { deletedAt: expect.any(String) } });
    const events = await store.pull(workspaceId, '0', 100); expect(events.changes).toHaveLength(2);
    expect((await store.get!(workspaceId, 'song', created.entityId))!.document.deletedAt).toEqual(expect.any(String));
  });

  it('bootstrap é fotografia consistente: escrita posterior entra somente no pull após cutCursor', async () => {
    const store = new InMemorySyncStore(); await store.apply(workspaceId, actorId, op(), deviceId);
    const first = await store.bootstrap!(workspaceId, 1); const after = op(); await store.apply(workspaceId, actorId, after, deviceId);
    const snapshotIds = [...first.documents.map((document) => document.entityId)];
    if (first.hasMore) snapshotIds.push(...(await store.bootstrapPage!(workspaceId, first.token, first.nextCursor, 100)).documents.map((document) => document.entityId));
    expect(snapshotIds).not.toContain(after.entityId);
    expect(await store.pull(workspaceId, first.cutCursor, 100)).toMatchObject({ changes: [expect.objectContaining({ entityId: after.entityId })] });
  });

  it('AT-23: cursor e dispositivo antigos recebem erro explícito, sem reaplicar pendência', async () => {
    const store = new InMemorySyncStore(); await store.apply(workspaceId, actorId, op(), deviceId); store.expireCursorBefore(workspaceId, '1');
    await expect(store.pull(workspaceId, '0', 100)).rejects.toMatchObject({ statusCode: 410, code: 'CURSOR_EXPIRED' });
    store.expireDevice(workspaceId, deviceId);
    await expect(store.apply(workspaceId, actorId, op(), deviceId)).rejects.toMatchObject({ statusCode: 410, code: 'DEVICE_EXPIRED' });
  });
});
