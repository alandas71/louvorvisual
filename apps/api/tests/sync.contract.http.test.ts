import { randomUUID } from 'node:crypto';
import { apiErrorSchema, apiSuccessSchema, syncBootstrapResponseSchema, syncPullResponseSchema, syncPushResponseSchema, type SyncOperation } from '@louvorvisual/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { song } from '../../../packages/contracts/src/fixtures';
import { createApp } from '../src/app';
import { InMemorySyncStore } from '../src/modules/sync/in-memory-sync-store';
import type { SyncStore } from '../src/modules/sync/sync-store';

const workspaceId = '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d';
const otherWorkspaceId = '7f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d';
const actorId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const pushResponse = apiSuccessSchema(syncPushResponseSchema);
const pullResponse = apiSuccessSchema(syncPullResponseSchema);
const bootstrapResponse = apiSuccessSchema(syncBootstrapResponseSchema);

function createSong(entityId: string = randomUUID(), workspace = workspaceId): SyncOperation {
  return { opId: randomUUID(), entityType: 'song', entityId, action: 'create', baseRevision: '0', schemaVersion: 1, payload: { ...song, id: entityId, workspaceId: workspace } };
}

function follow(previous: SyncOperation, action: SyncOperation['action'], baseRevision: string): SyncOperation {
  return { ...previous, opId: randomUUID(), action, baseRevision };
}

function client(syncStore: SyncStore = new InMemorySyncStore()) {
  const app = createApp({ syncStore, actorId: () => actorId });
  return {
    push: (operations: unknown[], workspace = workspaceId) =>
      request(app).post(`/api/v1/workspaces/${workspace}/sync/push`).send({ deviceId: randomUUID(), clientSchemaVersion: 1, operations }),
    pull: (query = '', workspace = workspaceId) => request(app).get(`/api/v1/workspaces/${workspace}/sync/pull${query}`),
    raw: (body: string) => request(app).post(`/api/v1/workspaces/${workspaceId}/sync/push`).set('content-type', 'application/json').send(body),
    bootstrap: () => request(app).post(`/api/v1/workspaces/${workspaceId}/sync/bootstrap`).send({ limit: 1 }),
    bootstrapPage: (token: string, cursor: string) => request(app).get(`/api/v1/workspaces/${workspaceId}/sync/bootstrap/${token}?cursor=${cursor}&limit=1`),
  };
}

describe('respostas seguem os contratos compartilhados', () => {
  it('push aceito e pull, com e sem parâmetros', async () => {
    const api = client();
    const pushed = await api.push([createSong()]).expect(200);
    expect(pushResponse.parse(pushed.body).data.results[0]).toMatchObject({ status: 'accepted', revision: '1', cursor: '1' });

    const pulled = await api.pull('?cursor=0&limit=10').expect(200);
    const { changes, nextCursor, hasMore } = pullResponse.parse(pulled.body).data;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.document).toMatchObject({ serverRevision: '1', updatedBy: actorId });
    expect({ nextCursor, hasMore }).toEqual({ nextCursor: '1', hasMore: false });

    expect(pullResponse.parse((await api.pull().expect(200)).body).data.changes).toHaveLength(1);
  });

  it('revisões e cursores passam de um dígito', async () => {
    const api = client();
    let operation = createSong();
    await api.push([operation]).expect(200);
    for (let revision = 1; revision <= 10; revision++) {
      operation = follow(operation, 'update', String(revision));
      const response = await api.push([operation]).expect(200);
      expect(pushResponse.parse(response.body).data.results[0]).toMatchObject({ status: 'accepted', revision: String(revision + 1) });
    }
    const page = pullResponse.parse((await api.pull('?cursor=9&limit=1').expect(200)).body).data;
    expect(page).toMatchObject({ nextCursor: '10', hasMore: true });
  });

  it('conflito devolve a revisão atual e o documento remoto', async () => {
    const api = client();
    const created = createSong();
    await api.push([created]).expect(200);
    const response = await api.push([follow(created, 'update', '7')]).expect(200);
    expect(pushResponse.parse(response.body).data.results[0]).toMatchObject({ status: 'conflict', currentRevision: '1' });
  });

  it('exclusão vira tombstone e restauração o remove', async () => {
    const api = client();
    const created = createSong();
    await api.push([created, follow(created, 'delete', '1'), follow(created, 'restore', '2')]).expect(200);
    const { changes } = pullResponse.parse((await api.pull().expect(200)).body).data;
    expect(changes.map((change) => [change.action, change.document.deletedAt === null])).toEqual([
      ['create', true],
      ['delete', false],
      ['restore', true],
    ]);
  });

  it('bootstrap mantém fotografia paginada e devolve marca de corte para pull', async () => {
    const api = client(); await api.push([createSong(), createSong()]).expect(200);
    const first = bootstrapResponse.parse((await api.bootstrap().expect(200)).body).data;
    expect(first).toMatchObject({ documents: [expect.any(Object)], cutCursor: '2', hasMore: true });
    const second = bootstrapResponse.parse((await api.bootstrapPage(first.token, first.nextCursor).expect(200)).body).data;
    expect(second.documents).toHaveLength(1); expect(second.cutCursor).toBe(first.cutCursor);
  });
});

describe('lote', () => {
  it('aplica em ordem: criar e atualizar o mesmo agregado no mesmo lote', async () => {
    const created = createSong();
    const response = await client().push([created, follow(created, 'update', '1')]).expect(200);
    expect(response.body.data.results.map((result: { status: string }) => result.status)).toEqual(['accepted', 'accepted']);
  });

  it('não inicia uma operação antes de a anterior terminar', async () => {
    let running = 0;
    let maxRunning = 0;
    const inner = new InMemorySyncStore();
    const store: SyncStore = {
      pull: (...args) => inner.pull(...args),
      async apply(...args) {
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return inner.apply(...args);
      },
    };
    await client(store).push([createSong(), createSong(), createSong()]).expect(200);
    expect(maxRunning).toBe(1);
  });
});

describe('isolamento entre espaços', () => {
  it('pull de um espaço não mostra eventos de outro, e cada um tem seu cursor', async () => {
    const api = client();
    await api.push([createSong(), createSong()]).expect(200);
    expect(pullResponse.parse((await api.pull('', otherWorkspaceId).expect(200)).body).data).toEqual({ changes: [], nextCursor: '0', hasMore: false });
    const other = await api.push([createSong(randomUUID(), otherWorkspaceId)], otherWorkspaceId).expect(200);
    expect(other.body.data.results[0]).toMatchObject({ status: 'accepted', cursor: '1' });
  });

  it('recusa documento de outro espaço em vez de regravá-lo', async () => {
    const api = client();
    const response = await api.push([createSong(randomUUID(), otherWorkspaceId)]).expect(200);
    expect(pushResponse.parse(response.body).data.results[0]).toMatchObject({ status: 'rejected', code: 'WORKSPACE_MISMATCH' });
    expect((await api.pull().expect(200)).body.data.changes).toEqual([]);
  });
});

describe('erros', () => {
  it('validação responde 400 no envelope de erro', async () => {
    const response = await client().push([]).expect(400);
    expect(apiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    await client().pull('?limit=0').expect(400);
    await client().pull('?cursor=abc').expect(400);
  });

  it('JSON malformado é 400 e corpo acima do limite é 413, não 500', async () => {
    const api = client();
    expect(apiErrorSchema.parse((await api.raw('{"deviceId":').expect(400)).body).error.code).toBe('VALIDATION_ERROR');
    const large = JSON.stringify({ filler: 'a'.repeat(3 * 1024 * 1024) });
    expect(apiErrorSchema.parse((await api.raw(large).expect(413)).body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('leitura também exige identidade', async () => {
    await request(createApp()).get(`/api/v1/workspaces/${workspaceId}/sync/pull`).expect(401);
  });
});
