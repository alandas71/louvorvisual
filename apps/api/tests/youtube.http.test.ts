import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { AppError } from '../src/utils/AppError';
import { youtubeSongMetadata } from '../src/modules/import/youtube-import';

const url = 'https://youtu.be/abcdefghijk';
const imported = { title: 'Graça', artist: 'Artista', durationMs: 180000, sourceUrl: url, rawLyrics: 'Verso', syncedLyrics: '[00:12.00]Verso', lyricsId: 1, audio: Buffer.from('ID3audio') };
describe('importação do YouTube via HTTP', () => {
  it('exige autenticação e rejeita URLs externas antes de baixar', async () => {
    const importer = vi.fn().mockResolvedValue(imported);
    const app = createApp({ youtubeImporter: importer });
    await request(app).post('/api/v1/workspaces/' + randomUUID() + '/imports/youtube').send({ url }).expect(401);
    await request(app).post('/api/v1/workspaces/' + randomUUID() + '/imports/youtube').send({ url: 'http://localhost/private' }).expect(400);
    expect(importer).not.toHaveBeenCalled();
  });
  it('entrega os bytes de MP3 e a letra no mesmo multipart sem cache', async () => {
    const importer = vi.fn().mockResolvedValue(imported);
    const app = createApp({ actorId: () => randomUUID(), youtubeImporter: importer });
    const response = await request(app).post('/api/v1/workspaces/' + randomUUID() + '/imports/youtube').send({ url }).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200).expect('Cache-Control', 'private, no-store');
    const form = await new Response(response.body as Buffer, { headers: { 'content-type': response.headers['content-type']! } }).formData();
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({ title: 'Graça', durationMs: 180000 });
    expect(Buffer.from(await (form.get('audio') as Blob).arrayBuffer())).toEqual(imported.audio);
    expect(importer).toHaveBeenCalledTimes(1);
  });
  it('propaga falta de letra e permite tentar novamente', async () => {
    const importer = vi.fn().mockRejectedValueOnce(new AppError(422, 'DEPENDENCY_NOT_READY', 'Sem letra compatível.')).mockResolvedValue(imported);
    const app = createApp({ actorId: () => 'actor', youtubeImporter: importer });
    const route = '/api/v1/workspaces/' + randomUUID() + '/imports/youtube';
    await request(app).post(route).send({ url }).expect(422);
    await request(app).post(route).send({ url }).expect(200);
  });
  it('recusa importações simultâneas do mesmo usuário sem liberar a primeira', async () => {
    let release!: () => void;
    const importer = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return imported; });
    const app = createApp({ actorId: () => 'actor', youtubeImporter: importer });
    const route = '/api/v1/workspaces/' + randomUUID() + '/imports/youtube';
    const first = request(app).post(route).send({ url }).then(response => response);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
    await request(app).post(route).send({ url }).expect(429);
    await request(app).post(route).send({ url }).expect(429);
    release(); expect((await first).status).toBe(200);
  });
  it('recusa operador sem permissão de edição', async () => {
    const importer = vi.fn().mockResolvedValue(imported);
    const app = createApp({ youtubeImporter: importer });
    const signup = async (email: string) => (await request(app).post('/api/v1/auth/register').send({ name: 'Pessoa', email, password: 'senha suficientemente longa' }).expect(201)).body.data.accessToken as string;
    const admin = await signup('admin-import@example.test'); const operator = await signup('operator-import@example.test');
    const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
    const workspace = (await request(app).post('/api/v1/workspaces').set(auth(admin)).send({ name: 'Equipe' }).expect(201)).body.data.id;
    const invite = (await request(app).post('/api/v1/workspaces/' + workspace + '/invitations').set(auth(admin)).send({ email: 'operator-import@example.test', role: 'operator' }).expect(201)).body.data.token;
    await request(app).post('/api/v1/invitations/' + invite + '/accept').set(auth(operator)).expect(200);
    await request(app).post('/api/v1/workspaces/' + workspace + '/imports/youtube').set(auth(operator)).send({ url }).expect(403);
    expect(importer).not.toHaveBeenCalled();
  });
  it('identifica metadados musicais e remove marcadores do título do vídeo', () => {
    expect(youtubeSongMetadata({ title: 'Artista - Graça (Official Video)' })).toEqual({ title: 'Graça', artist: 'Artista' });
    expect(youtubeSongMetadata({ title: 'Vídeo', track: 'Graça', artist: 'Artista' })).toEqual({ title: 'Graça', artist: 'Artista' });
  });
});
