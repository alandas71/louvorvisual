import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { importAudio, wavFile } from './audio.helpers';
import { BrowserProfile, ORIGIN, ProductionServer, waitUntilInstalled } from './helpers';
import { createSong, openOperator, operator, SLIDE_TEXTS } from './presentation.helpers';
import {
  activeProfile,
  ApiServer,
  convergeTitle,
  DATABASE_URL,
  expectStoredTitle,
  gotoView,
  holdNextPushResponse,
  loseNextPushResponse,
  nudgeSync,
  openEditor,
  readDb,
  recordSync,
  register,
  retitle,
  serverDocument,
  serverRevisions,
  songByTitle,
  songs,
  sqlClient,
  stateOf,
  syncNow,
  syncUntilClean,
  type ActiveProfile,
  type LocalState,
} from './sync.helpers';

// Demonstração de sincronização com dois perfis de navegador como dispositivos
// distintos (A = Ana, administradora; B = Bruno, editor), contra a API real e
// um MySQL descartável. Requer:
//   LV_E2E_DATABASE_URL=<banco isolado, com as migrations aplicadas>
//   build do web feito com BACKEND_URL=http://127.0.0.1:3121
test.skip(!DATABASE_URL, 'Defina LV_E2E_DATABASE_URL para rodar a demonstração de sincronização.');
test.describe.configure({ mode: 'serial' });

const web = new ProductionServer();
const api = new ApiServer();
const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '10-evidencias');
const shot = (page: Page, name: string) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
const run = randomUUID().slice(0, 8);
const ANA = { name: 'Ana', email: `ana-${run}@example.test` };
const BRUNO = { name: 'Bruno', email: `bruno-${run}@example.test` };
const CARLA = { name: 'Carla', email: `carla-${run}@example.test` };
const TEAM = `Louvor E2E ${run}`;

let profileA: BrowserProfile;
let profileB: BrowserProfile;
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let a: Page;
let b: Page;
let logA: ReturnType<typeof recordSync>;
let logB: ReturnType<typeof recordSync>;
let teamA: ActiveProfile;
let teamB: ActiveProfile;
let workspaceId: string;

const status = (page: Page) => page.getByTestId('sync-status');
const pendingRows = (page: Page) => page.getByTestId('pending-row');
const conflictRows = (page: Page) => page.getByTestId('conflict-row');

test.beforeAll(async () => {
  await api.start();
  await web.start();
  // O build precisa encaminhar /api para a API de teste.
  const probe = await fetch(`${ORIGIN}/api/v1/auth/me`);
  expect(probe.status, 'o build do web não encaminha /api: gere-o com BACKEND_URL=http://127.0.0.1:3121').toBe(401);
  profileA = new BrowserProfile();
  profileB = new BrowserProfile();
  ctxA = await profileA.open();
  ctxB = await profileB.open();
  logA = recordSync(ctxA);
  logB = recordSync(ctxB);
  a = await ctxA.newPage();
  b = await ctxB.newPage();
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
  profileA?.remove();
  profileB?.remove();
  await web.stop();
  await api.stop();
  // Saída da API da execução: um 500 no meio da demonstração só se explica por ela.
  mkdirSync(join(__dirname, '..', 'test-results'), { recursive: true });
  writeFileSync(join(__dirname, '..', 'test-results', 'sync-api-output.log'), api.output.join(''));
});

test('preparo: duas contas, uma equipe, um perfil isolado em cada dispositivo', async () => {
  test.setTimeout(180_000);
  await a.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(a);
  await b.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(b);

  // Antes de entrar: perfil pessoal, que nunca é enviado.
  const personal = await activeProfile(a);
  expect(personal.kind).toBe('personal');
  await expect(a.getByTestId('sync-chip')).toHaveAttribute('data-connection', 'local-only');

  await register(a, ANA.name, ANA.email);
  await expect(a.getByTestId('account-state')).toHaveAttribute('data-state', 'signed-in');
  await a.getByLabel('Nova equipe').fill(TEAM);
  await a.getByRole('button', { name: 'Criar e usar' }).click();
  await expect(a.getByTestId('active-profile')).toHaveAttribute('data-kind', 'team');
  teamA = await activeProfile(a);
  workspaceId = teamA.workspaceId;
  expect(teamA.dbName).not.toBe('louvorvisual');

  // Convite para Bruno como editor.
  await a.getByLabel('Convidar por e-mail').fill(BRUNO.email);
  await a.getByLabel('Papel', { exact: true }).selectOption('editor');
  await a.getByRole('button', { name: 'Gerar convite' }).click();
  const token = await a.getByTestId('invite-token').getAttribute('data-token');
  expect(token).toBeTruthy();

  await register(b, BRUNO.name, BRUNO.email);
  await expect(b.getByTestId('workspaces-empty')).toBeVisible();
  await b.getByLabel('Código de convite').fill(token!);
  await b.getByRole('button', { name: 'Aceitar convite' }).click();
  await b.getByTestId('workspace-row').getByRole('button', { name: 'Usar neste dispositivo' }).click();
  await expect(b.getByTestId('active-profile')).toHaveAttribute('data-kind', 'team');
  teamB = await activeProfile(b);

  // Mesmo espaço, usuários, perfis, bancos e dispositivos diferentes.
  expect(teamB.workspaceId).toBe(workspaceId);
  expect(teamB.userId).not.toBe(teamA.userId);
  expect(teamB.dbName).not.toBe(teamA.dbName);
  await syncNow(a);
  await syncNow(b);
  await expect(status(b)).toHaveAttribute('data-pending', '0');
});

test('AT-10: criar e importar áudio offline, reconectar e convergir no segundo dispositivo', async () => {
  test.setTimeout(240_000);
  await ctxA.setOffline(true);
  await createSong(a, { title: 'Manhã de Gratidão', durations: ['4', '3', null] });
  const audio = wavFile('playback-manha.wav', 2);
  await importAudio(a, 'playback', audio);

  const song = await songByTitle(a, teamA.dbName, 'Manhã de Gratidão');
  expect(song.workspaceId).toBe(workspaceId);
  // Salvo neste dispositivo, com pendência e sem revisão de servidor.
  expect(await stateOf(a, teamA.dbName, `song:${song.id}`)).toMatchObject({ dirty: 1, serverRevision: null });

  await gotoView(a, 'sync');
  await expect(status(a)).toHaveAttribute('data-connection', 'offline', { timeout: 30_000 });
  await expect(status(a)).toHaveAttribute('data-pending', '3');
  await expect(pendingRows(a)).toHaveCount(3);
  // Áudio espera o upload; arranjo espera louvor e áudio.
  await expect(a.locator('[data-testid="pending-row"][data-key^="asset:"]')).toHaveAttribute('data-phase', 'waiting-upload');
  await expect(a.locator('[data-testid="pending-row"][data-key^="arrangement:"]')).toHaveAttribute('data-phase', 'waiting-dependency');
  expect(logA.pushes).toHaveLength(0);
  await shot(a, 'pendencias-offline');

  // Reconectar.
  await ctxA.setOffline(false);
  await syncUntilClean(a);
  await expect(a.getByTestId('pending-empty')).toBeVisible();
  await shot(a, 'sincronizado');
  // Dependências saíram em chamadas separadas e na ordem: arquivo e louvor, depois o arranjo.
  const sentTypes = logA.pushes.map((push) => push.operations.map((operation) => operation.entityType).sort());
  expect(sentTypes).toEqual([['asset', 'song'], ['arrangement']]);
  expect(logA.pushes.flatMap((push) => push.operations).every((operation) => operation.action === 'create' && operation.baseRevision === '0')).toBe(true);
  expect(await stateOf(a, teamA.dbName, `song:${song.id}`)).toMatchObject({ dirty: 0, serverRevision: '1', localGeneration: expect.any(Number) });
  expect(await serverDocument(ctxA, workspaceId, 'songs', song.id)).toMatchObject({ status: 200, revision: '1', document: { title: 'Manhã de Gratidão', updatedBy: teamA.userId } });

  // Segundo dispositivo.
  await syncUntilClean(b);
  const onB = await readDb(b, teamB.dbName, ['songs', 'arrangements', 'assets', 'assetBlobs', 'entityStates']);
  const onA = await readDb(a, teamA.dbName, ['songs', 'arrangements', 'assets', 'assetBlobs']);
  // Mesmos IDs, sem duplicatas.
  for (const table of ['songs', 'arrangements', 'assets'] as const) {
    expect(onB[table]!.map((row) => row.id).sort(), table).toEqual(onA[table]!.map((row) => row.id).sort());
    expect(onB[table]).toHaveLength(1);
  }
  // A sincronização traz os registros, sem baixar o áudio.
  expect(onB.assetBlobs).toHaveLength(0);
  expect(onB.assets![0]).toMatchObject({ remoteState: 'ready', sha256: onA.assetBlobs![0]!.sha256 });
  expect((onB.entityStates as unknown as LocalState[]).every((state) => state.dirty === 0 && state.serverRevision === '1')).toBe(true);
  expect(logB.pushes).toHaveLength(0);

  // Ouvir online não grava bytes; o download é uma escolha para uso offline.
  await gotoView(b, 'biblioteca');
  await expect(b.getByTestId('library-item')).toHaveCount(1);
  await openEditor(b, song.id);
  const track = b.getByTestId('audio-playback').getByTestId('audio-track');
  await expect(track).toHaveAttribute('data-present', 'false');
  await track.getByRole('button', { name: 'Ouvir playback-manha.wav', exact: true }).click();
  const player = track.getByTestId('audio-listen');
  await expect(player).toHaveAttribute('src', new RegExp('/api/v1/workspaces/.*/assets/.*/content'));
  await player.evaluate(async (element: HTMLAudioElement) => { await element.play(); });
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  await player.evaluate((element: HTMLAudioElement) => element.pause());
  expect((await readDb(b, teamB.dbName, ['assetBlobs'])).assetBlobs).toHaveLength(0);
  await track.getByRole('button', { name: 'Baixar playback-manha.wav', exact: true }).click();
  await expect(track).toHaveAttribute('data-present', 'true');
  const downloaded = await readDb(b, teamB.dbName, ['assetBlobs']);
  expect(downloaded.assetBlobs![0]).toMatchObject({ state: 'ready', sha256: onA.assetBlobs![0]!.sha256, byteSize: audio.buffer.length, blobSize: audio.buffer.length });
});

test('AT-11: duas pessoas editam a mesma revisão offline; conflito explícito; resolução produz nova revisão', async () => {
  test.setTimeout(240_000);
  const song = await songByTitle(a, teamA.dbName, 'Manhã de Gratidão');
  await ctxA.setOffline(true);
  await ctxB.setOffline(true);
  await openEditor(a, song.id);
  await retitle(a, teamA.dbName, song.id, 'Manhã de Gratidão (Ana)');
  await openEditor(b, song.id);
  await retitle(b, teamB.dbName, song.id, 'Manhã de Gratidão (Bruno)');

  await ctxA.setOffline(false);
  await syncUntilClean(a);
  expect(await serverDocument(ctxA, workspaceId, 'songs', song.id)).toMatchObject({ revision: '2', document: { title: 'Manhã de Gratidão (Ana)' } });

  // B reconecta: a edição dele não é enviada por cima nem substituída.
  await ctxB.setOffline(false);
  await syncNow(b);
  await expect(status(b)).toHaveAttribute('data-conflicts', '1');
  await expect(b.getByTestId('sync-chip')).toHaveAttribute('data-conflicts', '1');
  await expect(conflictRows(b)).toHaveCount(1);
  await expect(conflictRows(b)).toHaveAttribute('data-kind', 'both-edited');
  expect((await songByTitle(b, teamB.dbName, 'Manhã de Gratidão (Bruno)')).id).toBe(song.id);
  expect(await serverDocument(ctxB, workspaceId, 'songs', song.id)).toMatchObject({ revision: '2', document: { title: 'Manhã de Gratidão (Ana)' } });
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ dirty: 1, serverRevision: '1' });

  // Tela de conflito: versão local, remota, base e autor.
  await conflictRows(b).getByRole('button', { name: 'Comparar e resolver' }).click();
  const panel = b.getByTestId('conflict-panel');
  await expect(panel.getByTestId('conflict-revisions')).toHaveAttribute('data-base', '1');
  await expect(panel.getByTestId('conflict-revisions')).toHaveAttribute('data-remote', '2');
  await expect(panel.getByTestId('conflict-author')).toHaveText('Ana');
  await expect(panel.getByTestId('conflict-local').locator('[data-field="Título"]')).toContainText('Manhã de Gratidão (Bruno)');
  await expect(panel.getByTestId('conflict-remote').locator('[data-field="Título"]')).toContainText('Manhã de Gratidão (Ana)');
  await expect(panel.getByTestId('conflict-local').locator('[data-field="Título"]')).toHaveAttribute('data-differs', 'true');
  await expect(panel.getByTestId('conflict-local').locator('[data-field="Letra"]')).toHaveAttribute('data-differs', 'false');
  await shot(b, 'conflito-versao-local-e-remota');

  // "Manter minha versão": nova edição sobre a revisão remota atual.
  await panel.getByRole('button', { name: 'Manter minha versão' }).click();
  await expect(b.getByTestId('sync-message')).toContainText('nova revisão');
  await syncUntilClean(b);
  expect(await serverDocument(ctxB, workspaceId, 'songs', song.id)).toMatchObject({ revision: '3', document: { title: 'Manhã de Gratidão (Bruno)', updatedBy: teamB.userId } });
  expect(logB.pushes.at(-1)!.operations[0]).toMatchObject({ action: 'update', baseRevision: '2', entityId: song.id });
  // Nenhuma variante perdida: a remota ficou arquivada em B, e as três revisões existem no servidor.
  const archived = ((await readDb(b, teamB.dbName, ['revisions'])).revisions as { reason: string }[]).filter((revision) => revision.reason.startsWith('conflict-'));
  expect(archived).toMatchObject([{ reason: 'conflict-remote', entityId: song.id, document: { title: 'Manhã de Gratidão (Ana)' } }]);
  expect(await serverRevisions(ctxB, workspaceId, 'song', song.id)).toEqual(['3', '2', '1']);

  // A converge para a revisão resolvida.
  await convergeTitle(a, teamA.dbName, song.id, 'Manhã de Gratidão (Bruno)');
  expect(await stateOf(a, teamA.dbName, `song:${song.id}`)).toMatchObject({ dirty: 0, serverRevision: '3' });
});

test('AT-12: resposta perdida após o commit; a repetição usa o mesmo opId e não cria outra revisão', async () => {
  test.setTimeout(180_000);
  const song = (await songs(b, teamB.dbName)).find((item) => item.deletedAt === null)!;
  await openEditor(b, song.id);
  const before = logB.pushes.length;
  await loseNextPushResponse(ctxB);
  await retitle(b, teamB.dbName, song.id, 'Manhã de Gratidão (resposta perdida)');
  await nudgeSync(b);
  await expect(b.getByTestId('sync-chip')).toHaveAttribute('data-connection', 'offline', { timeout: 30_000 });
  // Sem rede a partir daqui: a repetição automática fica para depois de reabrir o navegador.
  await ctxB.setOffline(true);
  await b.getByTestId('sync-chip').click();
  // O servidor já confirmou; o dispositivo ainda não sabe.
  expect(await serverDocument(ctxA, workspaceId, 'songs', song.id)).toMatchObject({ revision: '4', document: { title: 'Manhã de Gratidão (resposta perdida)' } });
  await shot(b, 'resposta-perdida-tentativa-em-transito');
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ dirty: 1, serverRevision: '3' });
  const row = b.locator(`[data-testid="pending-row"][data-key="song:${song.id}"]`);
  await expect(row).toHaveAttribute('data-phase', 'sending');
  const opId = await row.getAttribute('data-op-id');
  expect(logB.pushes[before]!.operations[0]!.opId).toBe(opId);

  // Fechar e reabrir o navegador com a tentativa em trânsito: ela é recuperada, não recriada.
  await ctxB.close();
  ctxB = await profileB.open();
  logB = recordSync(ctxB);
  b = await ctxB.newPage();
  await syncUntilClean(b);
  const retried = logB.pushes.flatMap((push) => push.operations).filter((operation) => operation.entityId === song.id);
  expect(retried.map((operation) => operation.opId)).toEqual([opId]);
  expect(retried[0]).toMatchObject({ baseRevision: '3', payload: { title: 'Manhã de Gratidão (resposta perdida)' } });
  // Exatamente uma revisão a mais no servidor.
  expect(await serverRevisions(ctxB, workspaceId, 'song', song.id)).toEqual(['4', '3', '2', '1']);
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ dirty: 0, serverRevision: '4', conflict: null });
  await expect(conflictRows(b)).toHaveCount(0);
});

test('AT-24: pull durante a edição não troca o texto; ack antigo não substitui geração mais nova', async () => {
  test.setTimeout(240_000);
  const song = (await songs(b, teamB.dbName)).find((item) => item.deletedAt === null)!;
  await syncUntilClean(a);

  // --- ack antigo com geração mais nova -------------------------------------
  await openEditor(b, song.id);
  const mark = logB.pushes.length;
  const held = await holdNextPushResponse(ctxB);
  await retitle(b, teamB.dbName, song.id, 'Geração enviada');
  await nudgeSync(b);
  await held.arrived;
  // A resposta da "Geração enviada" ainda não chegou e o operador continua digitando.
  await retitle(b, teamB.dbName, song.id, 'Geração mais nova, digitada durante o envio');
  const during = await stateOf(b, teamB.dbName, `song:${song.id}`);
  held.release();
  await expect.poll(async () => (await stateOf(b, teamB.dbName, `song:${song.id}`))?.dirty, { timeout: 30_000 }).toBe(0);
  const sent = logB.pushes.slice(mark).flatMap((push) => push.operations);
  expect(sent.map((operation) => operation.payload.title)).toEqual(['Geração enviada', 'Geração mais nova, digitada durante o envio']);
  expect(sent.map((operation) => operation.baseRevision)).toEqual(['4', '5']);
  expect(sent[0]!.opId).not.toBe(sent[1]!.opId);
  // A confirmação da primeira nunca regravou o que estava na tela nem no banco.
  await expect(b.getByLabel('Título')).toHaveValue('Geração mais nova, digitada durante o envio');
  await expectStoredTitle(b, teamB.dbName, song.id, 'Geração mais nova, digitada durante o envio');
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ serverRevision: '6', localGeneration: during!.localGeneration });
  expect(await serverDocument(ctxB, workspaceId, 'songs', song.id)).toMatchObject({ revision: '6', document: { title: 'Geração mais nova, digitada durante o envio' } });

  // --- pull com o editor aberto ---------------------------------------------
  // B continua com o editor aberto, sem alteração pendente. A publica a revisão 7.
  await syncUntilClean(a);
  await openEditor(a, song.id);
  await retitle(a, teamA.dbName, song.id, 'Alterado por Ana com o editor de Bruno aberto');
  await syncUntilClean(a);

  await nudgeSync(b);
  const notice = b.getByTestId('editor-sync-notice');
  await expect(notice).toHaveAttribute('data-kind', 'remote-newer', { timeout: 30_000 });
  await expect(notice).toHaveAttribute('data-remote-revision', '7');
  await shot(b, 'editor-versao-remota-mais-nova');
  // O que está na tela e no banco de B não mudou.
  await expect(b.getByLabel('Título')).toHaveValue('Geração mais nova, digitada durante o envio');
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ serverRevision: '6', dirty: 0, deferredRemote: { revision: '7' } });
  await expectStoredTitle(b, teamB.dbName, song.id, 'Geração mais nova, digitada durante o envio');

  // B digita por cima da versão antiga: vira conflito, não sobrescrita do remoto.
  const pushesBefore = logB.pushes.length;
  await retitle(b, teamB.dbName, song.id, 'Bruno digitou sem ver a revisão 7');
  await nudgeSync(b);
  await expect(notice).toHaveAttribute('data-kind', 'conflict', { timeout: 30_000 });
  expect(logB.pushes).toHaveLength(pushesBefore);
  await shot(b, 'editor-em-conflito');
  expect(await serverDocument(ctxB, workspaceId, 'songs', song.id)).toMatchObject({ revision: '7', document: { title: 'Alterado por Ana com o editor de Bruno aberto' } });
  await expect(b.getByLabel('Título')).toHaveValue('Bruno digitou sem ver a revisão 7');

  // Resolver; a resposta do envio da resolução se perde; repetir.
  await notice.getByRole('button', { name: 'Comparar e resolver' }).click();
  const panel = b.getByTestId('conflict-panel');
  await expect(panel.getByTestId('conflict-revisions')).toHaveAttribute('data-base', '6');
  await expect(panel.getByTestId('conflict-revisions')).toHaveAttribute('data-remote', '7');
  await loseNextPushResponse(ctxB);
  await panel.getByRole('button', { name: 'Manter minha versão' }).click();
  await expect(status(b)).toHaveAttribute('data-connection', 'offline', { timeout: 30_000 });
  expect(await serverDocument(ctxB, workspaceId, 'songs', song.id)).toMatchObject({ revision: '8', document: { title: 'Bruno digitou sem ver a revisão 7' } });
  const lost = logB.pushes.at(-1)!.operations[0]!;
  await syncUntilClean(b);
  expect(logB.pushes.at(-1)!.operations[0]).toMatchObject({ opId: lost.opId, baseRevision: '7' });
  expect(await serverRevisions(ctxB, workspaceId, 'song', song.id)).toHaveLength(8);
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ dirty: 0, serverRevision: '8', conflict: null });
  await convergeTitle(a, teamA.dbName, song.id, 'Bruno digitou sem ver a revisão 7');
});

test('a apresentação em andamento não muda por sincronização sem comando do operador', async () => {
  test.setTimeout(240_000);
  const song = (await songs(b, teamB.dbName)).find((item) => item.deletedAt === null)!;
  await openEditor(b, song.id);
  await openOperator(b);
  const current = operator(b).getByTestId('current-slide');
  await expect(current).toContainText('Com esperança eu vou caminhar');

  // A reescreve o primeiro slide e publica.
  await openEditor(a, song.id);
  await a.getByTestId('occurrence').nth(0).getByRole('button', { name: 'Editar texto do slide 1' }).click();
  await a.getByTestId('occurrence').nth(0).getByLabel('Texto do slide 1').fill('Texto novo publicado por Ana');
  await a.getByTestId('occurrence').nth(0).getByRole('button', { name: 'Concluir' }).click();
  await expect.poll(async () => JSON.stringify((await readDb(a, teamA.dbName, ['arrangements'])).arrangements).includes('Texto novo publicado por Ana')).toBe(true);
  await syncUntilClean(a);

  // Outra janela do mesmo dispositivo B sincroniza a biblioteca enquanto a apresentação segue.
  const second = await ctxB.newPage();
  await syncUntilClean(second);
  expect(JSON.stringify((await readDb(second, teamB.dbName, ['arrangements'])).arrangements)).toContain('Texto novo publicado por Ana');

  // A sessão continua com a base preparada.
  await expect(current).toContainText('Com esperança eu vou caminhar');
  await expect(current).not.toContainText('Texto novo publicado por Ana');
  await expect(operator(b)).toHaveAttribute('data-status', 'ready');
  const session = (await readDb(second, teamB.dbName, ['presentationSessions'])).presentationSessions!.find((row) => row.status === 'active');
  expect(JSON.stringify(session)).toContain(SLIDE_TEXTS[0]!.split('\n')[0]);
  expect(JSON.stringify(session)).not.toContain('Texto novo publicado por Ana');
  await second.close();
});

test('AT-13: exclusão em A e edição offline em B; tombstone propagado, edição preservada, sem ressurreição', async () => {
  test.setTimeout(240_000);
  await createSong(a, { title: 'Canção Passageira', durations: [null, null] });
  await syncUntilClean(a);
  await syncUntilClean(b);
  const song = await songByTitle(b, teamB.dbName, 'Canção Passageira');

  await ctxB.setOffline(true);
  await openEditor(b, song.id);
  await retitle(b, teamB.dbName, song.id, 'Canção Passageira (edição offline de Bruno)');

  await gotoView(a, 'biblioteca');
  await a.getByRole('button', { name: 'Excluir Canção Passageira' }).click();
  await a.getByRole('button', { name: 'Mover para a lixeira' }).click();
  await expect(a.getByText('foi para a lixeira')).toBeVisible();
  await syncUntilClean(a);
  const deleted = await serverDocument(ctxA, workspaceId, 'songs', song.id);
  expect(deleted).toMatchObject({ revision: '2' });
  expect(deleted.document!.deletedAt).not.toBeNull();

  await ctxB.setOffline(false);
  const mark = logB.pushes.length;
  await syncNow(b);
  const row = b.locator(`[data-testid="conflict-row"][data-entity-id="${song.id}"]`);
  await expect(row).toHaveAttribute('data-kind', 'remote-deleted');
  // Edição preservada; nenhum envio de B para o ID excluído.
  await expectStoredTitle(b, teamB.dbName, song.id, 'Canção Passageira (edição offline de Bruno)');
  expect(logB.pushes.slice(mark).flatMap((push) => push.operations).filter((operation) => operation.entityId === song.id)).toEqual([]);

  await row.getByRole('button', { name: 'Comparar e resolver' }).click();
  const panel = b.getByTestId('conflict-panel');
  await expect(panel.getByTestId('conflict-remote').locator('[data-field="Situação"]')).toContainText('Excluído');
  // Não há "manter minha versão" para um registro excluído.
  await expect(panel.locator('[data-action="keep-local"]')).toHaveCount(0);
  await shot(b, 'conflito-registro-excluido');
  await panel.getByRole('button', { name: 'Restaurar como novo registro' }).click();
  // O arranjo do louvor excluído também tinha sido excluído por A: B aceita essa exclusão.
  for (;;) {
    await syncNow(b);
    if ((await status(b).getAttribute('data-conflicts')) === '0') break;
    await conflictRows(b).first().getByRole('button', { name: 'Comparar e resolver' }).click();
    await b.getByTestId('conflict-panel').locator('[data-action="keep-remote"]').click();
  }
  await syncUntilClean(b);

  // O ID original continua excluído, na mesma revisão; a edição de B vive em um ID novo.
  const original = await serverDocument(ctxB, workspaceId, 'songs', song.id);
  expect(original.revision).toBe('2');
  expect(original.document!.deletedAt).not.toBeNull();
  const restored = await songByTitle(b, teamB.dbName, 'Canção Passageira (edição offline de Bruno) (minha versão)');
  expect(restored.id).not.toBe(song.id);
  expect(await serverDocument(ctxB, workspaceId, 'songs', restored.id)).toMatchObject({ revision: '1', document: { deletedAt: null } });

  await syncUntilClean(a);
  const libraryA = (await songs(a, teamA.dbName)).filter((item) => item.deletedAt === null).map((item) => item.title);
  expect(libraryA).toContain('Canção Passageira (edição offline de Bruno) (minha versão)');
  expect(libraryA).not.toContain('Canção Passageira');
});

test('AT-23: cursor e dispositivo muito antigos; bootstrap preserva pendências e nada antigo é reenviado', async () => {
  test.setTimeout(240_000);
  const sql = sqlClient();
  try {
    const song = (await songs(a, teamA.dbName)).find((item) => item.deletedAt === null && item.title.startsWith('Bruno digitou'))!;

    // --- cursor fora da retenção ---------------------------------------------
    await syncUntilClean(a);
    await ctxA.setOffline(true);
    await openEditor(a, song.id);
    await retitle(a, teamA.dbName, song.id, 'Pendente de Ana durante o cursor vencido');
    // Enquanto A está fora, B publica algo e a retenção avança além do cursor de A.
    await createSong(b, { title: 'Publicado enquanto A estava fora', durations: [null] });
    await syncUntilClean(b);
    await sql.$executeRawUnsafe(`UPDATE \`workspace_sync_clocks\` SET \`minCursor\` = \`nextCursor\` WHERE \`workspaceId\` = '${workspaceId}'`);

    await ctxA.setOffline(false);
    const bootstrapsBefore = logA.bootstraps.length;
    await syncUntilClean(a);
    expect(logA.bootstraps.length).toBeGreaterThan(bootstrapsBefore);
    // Base nova recebida e pendência preservada e publicada.
    expect((await songs(a, teamA.dbName)).map((item) => item.title)).toContain('Publicado enquanto A estava fora');
    expect(await serverDocument(ctxA, workspaceId, 'songs', song.id)).toMatchObject({ document: { title: 'Pendente de Ana durante o cursor vencido' } });
    const clocks = await sql.$queryRawUnsafe<{ nextCursor: bigint }[]>(`SELECT \`nextCursor\` FROM \`workspace_sync_clocks\` WHERE \`workspaceId\` = '${workspaceId}'`);
    await expect(status(a)).toHaveAttribute('data-cursor', String(clocks[0]!.nextCursor));

    // --- dispositivo fora da janela de idempotência ----------------------------
    const deviceId = logA.pushes.at(-1)!.deviceId;
    await openEditor(a, song.id);
    await loseNextPushResponse(ctxA);
    await retitle(a, teamA.dbName, song.id, 'Chegou ao servidor, resposta perdida');
    await nudgeSync(a);
    await expect(a.getByTestId('sync-chip')).toHaveAttribute('data-connection', 'offline', { timeout: 30_000 });
    // Sem rede até o dispositivo "envelhecer": a repetição automática não pode chegar antes.
    await ctxA.setOffline(true);
    const lost = logA.pushes.at(-1)!.operations[0]!;
    const revisionsAfterLost = await serverRevisions(ctxB, workspaceId, 'song', song.id);
    expect((await serverDocument(ctxB, workspaceId, 'songs', song.id)).document!.title).toBe('Chegou ao servidor, resposta perdida');

    await sql.$executeRawUnsafe(`UPDATE \`devices\` SET \`lastSeenAt\` = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY) WHERE \`id\` = '${deviceId}'`);
    const mark = logA.pushes.length;
    await ctxA.setOffline(false);
    await syncUntilClean(a);

    const after = logA.pushes.slice(mark);
    // A tentativa antiga saiu uma vez (recusada com DEVICE_EXPIRED) e nunca mais.
    expect(after[0]!.operations[0]!.opId).toBe(lost.opId);
    expect(after.slice(1).flatMap((push) => push.operations).map((operation) => operation.opId)).not.toContain(lost.opId);
    expect(logA.bootstraps.length).toBeGreaterThan(bootstrapsBefore + 1);
    // Reconciliação pelo conteúdo: o servidor já tinha a edição; nenhuma revisão nova, nenhum conflito.
    expect(await serverRevisions(ctxA, workspaceId, 'song', song.id)).toEqual(revisionsAfterLost);
    expect(await stateOf(a, teamA.dbName, `song:${song.id}`)).toMatchObject({ dirty: 0, serverRevision: revisionsAfterLost[0], conflict: null });
    await expect(conflictRows(a)).toHaveCount(0);
    // O dispositivo ganhou outra identidade para os próximos envios.
    const meta = (await readDb(a, teamA.dbName, ['syncMeta'])).syncMeta![0]!;
    expect(meta.deviceId).not.toBe(deviceId);
    await openEditor(a, song.id);
    await retitle(a, teamA.dbName, song.id, 'Depois da reconciliação');
    await syncUntilClean(a);
    expect(logA.pushes.at(-1)!.deviceId).toBe(meta.deviceId);
    await syncUntilClean(b);
  } finally {
    await sql.$disconnect();
  }
});

test('AT-19: mudar papel, revogar e trocar perfil; filas não se misturam e o que está preparado continua abrindo', async () => {
  test.setTimeout(300_000);
  const song = await songByTitle(b, teamB.dbName, 'Depois da reconciliação');
  const member = () => a.locator(`[data-testid="member-row"][data-email="${BRUNO.email}"]`);

  // --- papel rebaixado para operador ----------------------------------------
  await gotoView(a, 'conta');
  await a.getByLabel('Papel de Bruno').selectOption('operator');
  await expect(member()).toHaveAttribute('data-role', 'operator');

  await openEditor(b, song.id);
  await retitle(b, teamB.dbName, song.id, 'Tentativa de Bruno como operador');
  await syncNow(b, 'read-only');
  await expect(status(b)).toHaveAttribute('data-pending', '1');
  await shot(b, 'somente-leitura-operador');
  expect((await serverDocument(ctxA, workspaceId, 'songs', song.id)).document!.title).toBe('Depois da reconciliação');
  // Como operador, Bruno continua recebendo a biblioteca.
  await createSong(a, { title: 'Recebido por um operador', durations: [null] });
  await syncUntilClean(a);
  await syncNow(b, 'read-only');
  expect((await songs(b, teamB.dbName)).map((item) => item.title)).toContain('Recebido por um operador');

  // --- acesso revogado ---------------------------------------------------------
  await gotoView(a, 'conta');
  await member().getByRole('button', { name: 'Revogar acesso' }).click();
  await expect(member()).toHaveAttribute('data-status', 'revoked');

  const pushesBefore = logB.pushes.length;
  await syncNow(b, 'revoked');
  await expect(b.getByTestId('sync-revoked')).toBeVisible();
  await expect(b.getByTestId('sync-chip')).toHaveAttribute('data-connection', 'revoked');
  await shot(b, 'acesso-revogado');
  // O servidor bloqueia leitura e envio.
  expect((await ctxB.request.get(`${ORIGIN}/api/v1/workspaces/${workspaceId}/sync/pull?cursor=0`)).status()).toBe(403);
  expect((await serverDocument(ctxB, workspaceId, 'songs', song.id)).status).toBe(403);
  expect(logB.pushes).toHaveLength(pushesBefore);
  // A pendência continua recuperável e não foi publicada.
  await expect(status(b)).toHaveAttribute('data-pending', '1');
  await expectStoredTitle(b, teamB.dbName, song.id, 'Tentativa de Bruno como operador');
  expect((await serverDocument(ctxA, workspaceId, 'songs', song.id)).document!.title).toBe('Depois da reconciliação');
  const download = b.waitForEvent('download');
  await b.getByTestId('export-pending').click();
  expect((await download).suggestedFilename()).toMatch(/^louvorvisual-pendencias-/);
  // O que já estava neste dispositivo continua abrindo e apresentando, mesmo sem rede.
  await ctxB.setOffline(true);
  await gotoView(b, 'biblioteca');
  await expect(b.getByRole('link', { name: 'Tentativa de Bruno como operador' })).toBeVisible();
  await openEditor(b, song.id);
  await openOperator(b);
  await ctxB.setOffline(false);

  // --- troca de usuário no mesmo navegador ----------------------------------
  await gotoView(b, 'conta');
  await b.getByTestId('logout').click();
  await b.locator('[data-action="logout-keep"]').click();
  await expect(b.getByTestId('account-state')).toHaveAttribute('data-state', 'signed-out');
  // O perfil de Bruno continua neste computador, com a pendência dele.
  expect(await stateOf(b, teamB.dbName, `song:${song.id}`)).toMatchObject({ dirty: 1 });

  await register(b, CARLA.name, CARLA.email);
  // Outra conta entrou: o perfil anterior deixa de ser carregado automaticamente.
  await expect(b.getByTestId('active-profile')).toHaveAttribute('data-kind', 'personal');
  await expect(b.locator('[data-testid="profile-row"][data-kind="team"]')).toContainText('1 pendente(s)');
  await shot(b, 'conta-troca-de-usuario-perfis');
  await b.getByLabel('Nova equipe').fill(`Equipe de Carla ${run}`);
  await b.getByRole('button', { name: 'Criar e usar' }).click();
  await expect(b.getByTestId('active-profile')).toHaveAttribute('data-kind', 'team');
  const teamC = await activeProfile(b);
  expect(teamC.userId).not.toBe(teamB.userId);
  expect(teamC.workspaceId).not.toBe(workspaceId);
  expect(teamC.dbName).not.toBe(teamB.dbName);

  // A fila de Carla nasce vazia; nada de Bruno aparece nem sai por ela.
  const mark = logB.pushes.length;
  await createSong(b, { title: 'Primeiro louvor de Carla', durations: [null] });
  await syncUntilClean(b);
  const carlaPushes = logB.pushes.slice(mark);
  expect(carlaPushes.length).toBeGreaterThan(0);
  expect(carlaPushes.every((push) => push.url.includes(teamC.workspaceId))).toBe(true);
  expect(carlaPushes.flatMap((push) => push.operations).some((operation) => operation.entityId === song.id)).toBe(false);
  expect((await songs(b, teamC.dbName)).map((item) => item.title)).toEqual(['Primeiro louvor de Carla']);
  const listed = await ctxB.request.get(`${ORIGIN}/api/v1/workspaces/${teamC.workspaceId}/songs`);
  expect(((await listed.json()) as { data: { document: { title: string } }[] }).data.map((item) => item.document.title)).toEqual(['Primeiro louvor de Carla']);

  // Reabrir o perfil de Bruno com a sessão de Carla: nada dele é enviado com a conta dela.
  await gotoView(b, 'conta');
  const afterSwitch = logB.pushes.length;
  await b.locator(`[data-testid="profile-row"][data-profile-id="${teamB.profileId}"]`).getByRole('button', { name: 'Abrir' }).click();
  await expect(b.getByTestId('active-profile')).toHaveAttribute('data-profile-id', teamB.profileId);
  await expect(b.getByTestId('account-mismatch')).toBeVisible();
  await gotoView(b, 'sync');
  await expect(status(b)).toHaveAttribute('data-connection', 'identity-mismatch', { timeout: 30_000 });
  await expect(b.getByTestId('sync-mismatch')).toBeVisible();
  await shot(b, 'perfil-de-outra-conta');
  await expect(status(b)).toHaveAttribute('data-pending', '1');
  expect(logB.pushes).toHaveLength(afterSwitch);
  expect((await serverDocument(ctxA, workspaceId, 'songs', song.id)).document!.title).toBe('Depois da reconciliação');

  // Remover os dados locais do perfil de Bruno apaga só o banco dele.
  await gotoView(b, 'conta');
  const row = b.locator(`[data-testid="profile-row"][data-profile-id="${teamB.profileId}"]`);
  await row.locator('[data-action="remove-profile"]').click();
  await row.locator('[data-action="confirm-remove-profile"]').click();
  await expect(b.getByTestId('active-profile')).toHaveAttribute('data-kind', 'personal');
  const databases = await b.evaluate(async () => (await indexedDB.databases()).map((database) => database.name));
  expect(databases).not.toContain(teamB.dbName);
  expect(databases).toContain(teamC.dbName);
  expect(databases).toContain('louvorvisual');
});
