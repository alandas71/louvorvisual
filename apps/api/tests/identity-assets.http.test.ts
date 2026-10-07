import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const password = 'senha de teste suficientemente longa';
async function signup(app: ReturnType<typeof createApp>, name: string, email: string) {
  const response = await request(app).post('/api/v1/auth/register').send({ name, email, password }).expect(201);
  const setCookie = response.headers['set-cookie'];
  return { id: response.body.data.user.id as string, token: response.body.data.accessToken as string, cookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [] };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary');

describe('identidade, isolamento e arquivos privados', () => {
  it('isola espaços, aplica papéis, protege o último admin e publica áudio somente após checksum', async () => {
    const app = createApp();
    const admin = await signup(app, 'Admin', 'admin@example.test');
    const outsider = await signup(app, 'Outra Pessoa', 'outra@example.test');
    const ws = await request(app).post('/api/v1/workspaces').set(auth(admin.token)).send({ name: 'Louvor A', timezone: 'America/Bahia' }).expect(201);
    const workspaceId = ws.body.data.id as string;
    await request(app).get(`/api/v1/workspaces/${workspaceId}/members`).set(auth(outsider.token)).expect(403);
    await request(app).post(`/api/v1/workspaces/${workspaceId}/invitations`).set(auth(admin.token)).send({ email: 'outra@example.test', role: 'operator' }).expect(201).then((response) => request(app).post(`/api/v1/invitations/${response.body.data.token}/accept`).set(auth(outsider.token)).expect(200));
    await request(app).patch(`/api/v1/workspaces/${workspaceId}/members/${admin.id}`).set(auth(admin.token)).send({ role: 'editor' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('LAST_ADMIN_PROTECTED'));
    const assetId = randomUUID(); const sha256 = createHash('sha256').update(wav).digest('hex');
    await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(outsider.token)).send({ id: assetId, sha256, filename: 'faixa.wav', mimeType: 'audio/wav', byteSize: wav.length, audioKind: 'playback', durationMs: null }).expect(403);
    const created = await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(admin.token)).send({ id: assetId, sha256, filename: 'faixa.wav', mimeType: 'audio/wav', byteSize: wav.length, audioKind: 'playback', durationMs: null }).expect(201);
    await request(app).put(`/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`).set(auth(admin.token)).set('Content-Type', 'audio/wav').set('Upload-Attempt-Id', created.body.data.uploadId).send(Buffer.from('invalido')).expect(400);
    const retried = await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(admin.token)).send({ id: assetId, sha256, filename: 'faixa.wav', mimeType: 'audio/wav', byteSize: wav.length, audioKind: 'playback', durationMs: null }).expect(201);
    await request(app).put(`/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`).set(auth(admin.token)).set('Content-Type', 'audio/wav').set('Upload-Attempt-Id', retried.body.data.uploadId).send(wav).expect(200);
    await request(app).get(`/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`).set(auth(outsider.token)).expect(200).expect('Cache-Control', 'private, no-store');
    const other = await request(app).post('/api/v1/workspaces').set(auth(outsider.token)).send({ name: 'Louvor B', timezone: 'UTC' }).expect(201);
    await request(app).get(`/api/v1/workspaces/${other.body.data.id}/assets/${assetId}/content`).set(auth(outsider.token)).expect(404);
  });

  it('mesmos bytes registrados por outro dispositivo com outro ID: o ID do cliente é preservado e baixa o mesmo conteúdo', async () => {
    const app = createApp(); const admin = await signup(app, 'Admin', 'ids@example.test');
    const ws = await request(app).post('/api/v1/workspaces').set(auth(admin.token)).send({ name: 'Louvor', timezone: 'UTC' }).expect(201); const workspaceId = ws.body.data.id as string;
    const sha256 = createHash('sha256').update(wav).digest('hex'); const body = (id: string, audioKind: string) => ({ id, sha256, filename: 'faixa.wav', mimeType: 'audio/wav', byteSize: wav.length, audioKind, durationMs: null });
    const first = randomUUID(); const second = randomUUID();
    const created = await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(admin.token)).send(body(first, 'playback')).expect(201);
    await request(app).put(`/api/v1/workspaces/${workspaceId}/assets/${first}/content`).set(auth(admin.token)).set('Content-Type', 'audio/wav').set('Upload-Attempt-Id', created.body.data.uploadId).send(wav).expect(200);
    const alias = await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(admin.token)).send(body(second, 'original')).expect(201);
    expect(alias.body.data).toMatchObject({ id: second, state: 'ready', audioKind: 'original' });
    const downloaded = await request(app).get(`/api/v1/workspaces/${workspaceId}/assets/${second}/content`).set(auth(admin.token)).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(createHash('sha256').update(downloaded.body as Buffer).digest('hex')).toBe(sha256);
    // Repetir o registro de um arquivo já pronto devolve o mesmo registro, sem voltar a pendente.
    const again = await request(app).post(`/api/v1/workspaces/${workspaceId}/assets`).set(auth(admin.token)).send(body(first, 'playback')).expect(201);
    expect(again.body.data).toMatchObject({ id: first, state: 'ready' });
  });

  it('rotaciona refresh e revoga toda a família quando token antigo é reutilizado', async () => {
    const app = createApp(); const account = await signup(app, 'Sessão', 'sessao@example.test');
    const refresh = account.cookies.find((cookie) => cookie.startsWith('lv_refresh='))!.split(';')[0]!.slice('lv_refresh='.length);
    const first = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: decodeURIComponent(refresh) }).expect(200);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: decodeURIComponent(refresh) }).expect(401).expect(({ body }) => expect(body.error.code).toBe('SESSION_REUSED'));
    await request(app).get('/api/v1/auth/me').set(auth(first.body.data.accessToken)).expect(401);
  });
});
