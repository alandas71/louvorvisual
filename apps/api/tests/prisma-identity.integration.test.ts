import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { LocalAssetStorage, PrismaIdentityStore } from '../src/modules/identity/prisma-identity-store';

const maybeDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const prisma = new PrismaClient();
const mediaDir = mkdtempSync(join(tmpdir(), 'louvorvisual-identity-'));
const email = `restart-${randomUUID()}@example.test`;
const password = 'senha de teste suficientemente longa';
const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary');
let userId = ''; let workspaceId = '';

const app = () => createApp({ identityStore: new PrismaIdentityStore(prisma, new LocalAssetStorage(mediaDir), 'integration-test-access-secret') });

maybeDescribe('PrismaIdentityStore: reinício da API', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect(); rmSync(mediaDir, { recursive: true, force: true });
  });

  it('preserva conta, equipe, sessão e bytes de áudio em uma nova instância', async () => {
    const first = app();
    const registered = await request(first).post('/api/v1/auth/register').send({ name: 'Persistente', email, password }).expect(201);
    userId = registered.body.data.user.id;
    const token = registered.body.data.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };
    const workspace = await request(first).post('/api/v1/workspaces').set(auth).send({ name: 'Após reinício', timezone: 'America/Bahia' }).expect(201);
    workspaceId = workspace.body.data.id;
    const assetId = randomUUID(); const sha256 = createHash('sha256').update(wav).digest('hex');
    const created = await request(first).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth).send({ id: assetId, sha256, filename: 'persistente.wav', mimeType: 'audio/wav', byteSize: wav.length, audioKind: 'playback', durationMs: null }).expect(201);
    await request(first).put(`/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`).set(auth).set('Content-Type', 'audio/wav').set('Upload-Attempt-Id', created.body.data.uploadId).send(wav).expect(200);

    const restarted = app();
    await request(restarted).get('/api/v1/auth/me').set(auth).expect(200).expect(({ body }) => expect(body.data.workspaces).toEqual([expect.objectContaining({ id: workspaceId, role: 'admin' })]));
    const downloaded = await request(restarted).get(`/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`).set(auth).buffer(true).parse((res, done) => { const chunks: Buffer[]=[]; res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>done(null,Buffer.concat(chunks))); }).expect(200);
    expect(downloaded.body).toEqual(wav);
  });
});
