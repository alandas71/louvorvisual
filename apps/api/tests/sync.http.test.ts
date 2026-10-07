import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { song } from '../../../packages/contracts/src/fixtures';
import { createApp } from '../src/app';
import { InMemorySyncStore } from '../src/modules/sync/in-memory-sync-store';

const workspaceId = '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d';
const actorId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function operation(opId = randomUUID(), entityId = song.id) {
  return { opId, entityType: 'song' as const, entityId, action: 'create' as const, baseRevision: '0', schemaVersion: 1 as const, payload: { ...song, id: entityId, workspaceId, serverRevision: null } };
}

describe('sync HTTP', () => {
  it('aceita, repete idempotentemente e recusa reutilização de opId', async () => {
    const app = createApp({ syncStore: new InMemorySyncStore(), actorId: () => actorId });
    const body = { deviceId: randomUUID(), clientSchemaVersion: 1, operations: [operation()] };
    const first = await request(app).post(`/api/v1/workspaces/${workspaceId}/sync/push`).send(body).expect(200);
    const retry = await request(app).post(`/api/v1/workspaces/${workspaceId}/sync/push`).send(body).expect(200);
    expect(retry.body.data.results[0]).toEqual(first.body.data.results[0]);
    const changed = structuredClone(body);
    changed.operations[0]!.payload.title = 'Outro título';
    await request(app).post(`/api/v1/workspaces/${workspaceId}/sync/push`).send(changed).expect(409).expect(({ body: response }) => {
      expect(response.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  it('não expõe escrita sem identidade autenticada', async () => {
    const app = createApp({ syncStore: new InMemorySyncStore() });
    await request(app).post(`/api/v1/workspaces/${workspaceId}/sync/push`).send({ deviceId: randomUUID(), clientSchemaVersion: 1, operations: [operation()] }).expect(401);
  });
});
