import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { chromium, expect, test, type Page } from '@playwright/test';
import { importAudio, tamperAudioBlobs, wavFile } from './audio.helpers';
import { BrowserProfile, cacheNames, isReachable, openHiddenView, ORIGIN, ProductionServer, publishServiceWorker, waitUntilInstalled } from './helpers';
import { createSong, openOperator, openProjection, operator, readStore, SLIDE_TEXTS, startShow } from './presentation.helpers';

// Recuperação (E6): pacote de repertório, lixeira e histórico, atualização do
// aplicativo durante a apresentação e falta de espaço. Sempre sobre o build de
// produção, com perfis de navegador em disco como dispositivos distintos.
const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '11-evidencias');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });

const server = new ProductionServer();
let profile: BrowserProfile;
let other: BrowserProfile;
let work: string;
let currentVersion: string;

test.beforeEach(async () => {
  currentVersion = publishServiceWorker();
  profile = new BrowserProfile();
  other = new BrowserProfile();
  work = mkdtempSync(join(tmpdir(), 'louvorvisual-pacote-'));
  await server.start();
});

test.afterEach(async () => {
  await server.stop();
  profile.remove();
  other.remove();
  rmSync(work, { recursive: true, force: true });
  publishServiceWorker();
});

type Stored = { id: string; workspaceId: string; title?: string; deletedAt: string | null };
type StoredAsset = Stored & { sha256: string; byteSize: number; remoteState: string; storageKey: string | null };
type StoredState = { key: string; dirty: number; serverRevision: string | null };

/**
 * Leitor de ZIP independente do aplicativo, só com o que o formato promete:
 * entradas armazenadas, índice no fim. É o que um leitor em outra plataforma
 * (o APK) faria.
 */
function readStoredZip(buffer: Buffer) {
  const end = buffer.length - 22;
  expect(buffer.readUInt32LE(end)).toBe(0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, { data: Buffer; dataOffset: number; localOffset: number; centralOffset: number }>();
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(buffer.readUInt16LE(cursor + 10), 'método de compressão').toBe(0);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataOffset = localOffset + 30 + nameLength;
    const data = buffer.subarray(dataOffset, dataOffset + size);
    expect(crc32(data), `CRC de ${name}`).toBe(buffer.readUInt32LE(cursor + 16));
    entries.set(name, { data, dataOffset, localOffset, centralOffset: cursor });
    cursor += 46 + nameLength;
  }
  return entries;
}

/** Troca um trecho do manifesto por outro do mesmo tamanho e refaz o CRC, como faria quem edita o arquivo. */
function editManifest(buffer: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const copy = Buffer.from(buffer);
  const entry = readStoredZip(copy).get('manifest.json')!;
  const text = entry.data.toString('utf8');
  expect(text).toContain(from);
  const next = Buffer.from(text.replace(from, to), 'utf8');
  next.copy(copy, entry.dataOffset);
  copy.writeUInt32LE(crc32(next), entry.localOffset + 14);
  copy.writeUInt32LE(crc32(next), entry.centralOffset + 16);
  return copy;
}

async function choosePackage(page: Page, path: string): Promise<void> {
  if (!page.url().includes('view=repertorios') || page.url().includes('repertorio=')) await page.goto(`${ORIGIN}/app?view=repertorios`);
  await page.locator('#pacote-arquivo').setInputFiles(path);
}

async function expectRefused(page: Page, path: string, code: string, text: string | RegExp): Promise<void> {
  await choosePackage(page, path);
  const error = page.getByTestId('import-error');
  await expect(error).toHaveAttribute('data-code', code);
  await expect(error).toContainText(text);
  await expect(error).toContainText('não foi alterada');
  await page.getByRole('button', { name: 'Escolher outro arquivo' }).click();
}

const counts = async (page: Page) => ({
  songs: (await readStore<Stored>(page, 'songs')).length,
  arrangements: (await readStore<Stored>(page, 'arrangements')).length,
  setlists: (await readStore<Stored>(page, 'setlists')).length,
  assets: (await readStore<Stored>(page, 'assets')).length,
  blobs: (await readStore<Stored>(page, 'assetBlobs')).length,
});

test('AT-18: exporta o repertório com áudio, importa offline em outro dispositivo com IDs novos, repete, e recusa pacote adulterado ou de versão incompatível', async () => {
  test.setTimeout(300_000);
  // ── dispositivo A: biblioteca, repertório e exportação ──────────────────
  let context = await profile.open();
  // Segredos plantados no perfil: nada disso pode aparecer no arquivo exportado.
  await context.addCookies([{ name: 'lv_refresh', value: 'SEGREDO-DE-SESSAO-123', url: ORIGIN, httpOnly: true }]);
  let page = await context.newPage();
  await createSong(page, { title: 'Em União', durations: ['3', '3'], install: true });
  await page.evaluate(() => localStorage.setItem('lv-token', 'SEGREDO-LOCAL-456'));
  const playback = wavFile('uniao-playback.wav', 6, 440);
  const original = wavFile('uniao-original.wav', 4, 660);
  await importAudio(page, 'playback', playback);
  await importAudio(page, 'original', original);
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await createSong(page, { title: 'Manhã de Gratidão', durations: [null, null] });
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByLabel('Nome do repertório').fill('Culto de domingo');
  await page.getByLabel('Data do culto').fill('2026-10-11');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  for (const [index, title] of ['Em União', 'Manhã de Gratidão'].entries()) {
    await page.getByLabel('Acrescentar louvor').selectOption({ label: `${title} — Culto` });
    await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
    await expect(page.getByTestId('setlist-item')).toHaveCount(index + 1);
  }

  const mediaBytes = playback.buffer.length + original.buffer.length;
  await expect(page.getByLabel('Áudio no pacote')).toHaveValue('all');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar pacote' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^repertorio-culto-de-domingo-\d{8}\.louvorvisual\.zip$/);
  const packagePath = join(work, download.suggestedFilename());
  await download.saveAs(packagePath);
  const result = page.getByTestId('package-export-result');
  await expect(result).toHaveAttribute('data-media', '2');
  await expect(result).toHaveAttribute('data-unavailable', '0');
  await shot(page, 'pacote-exportado');

  // ── o arquivo, lido fora do aplicativo ──────────────────────────────────
  const file = readFileSync(packagePath);
  expect(Number(await result.getAttribute('data-bytes'))).toBe(file.length);
  const zip = readStoredZip(file);
  const manifest = JSON.parse(zip.get('manifest.json')!.data.toString('utf8'));
  expect(manifest).toMatchObject({ format: 'louvorvisual-package', formatVersion: 1, minReaderVersion: 1, schemaVersion: 1, fontPackVersion: '1', mediaPolicy: 'all', omittedMedia: [], scope: { kind: 'setlist', title: 'Culto de domingo' } });
  // Manifesto e ZIP listam os mesmos arquivos, e cada um confere com tamanho e SHA-256.
  expect([...zip.keys()].sort()).toEqual(['manifest.json', ...manifest.entries.map((entry: { path: string }) => entry.path)].sort());
  for (const entry of manifest.entries as { path: string; byteSize: number; sha256: string }[]) {
    const { data } = zip.get(entry.path)!;
    expect(data.length, entry.path).toBe(entry.byteSize);
    expect(createHash('sha256').update(data).digest('hex'), entry.path).toBe(entry.sha256);
  }
  const kinds = (manifest.entries as { kind: string; entityType?: string }[]).map((entry) => entry.entityType ?? entry.kind).sort();
  expect(kinds).toEqual(['arrangement', 'arrangement', 'asset', 'asset', 'media', 'media', 'setlist', 'song', 'song']);
  expect(zip.get(`media/${createHash('sha256').update(playback.buffer).digest('hex')}`)!.data.equals(playback.buffer)).toBe(true);
  // Tokens ausentes: nem os segredos do perfil, nem campos de credencial em qualquer JSON.
  const raw = file.toString('latin1');
  for (const secret of ['SEGREDO-DE-SESSAO-123', 'SEGREDO-LOCAL-456', 'lv_refresh', 'lv-token']) expect(raw).not.toContain(secret);
  for (const [name, entry] of zip) {
    if (name.endsWith('.json')) expect(entry.data.toString('utf8')).not.toMatch(/token|cookie|password|senha|secret|refresh|deviceId|opId|email/i);
  }

  const originSongs = await readStore<Stored>(page, 'songs');
  const originAssets = await readStore<StoredAsset>(page, 'assets');
  const originIds = new Set([...originSongs, ...originAssets, ...(await readStore<Stored>(page, 'arrangements')), ...(await readStore<Stored>(page, 'setlists'))].map((row) => row.id));
  const originWorkspace = originSongs[0]!.workspaceId;
  expect(manifest.origin).toEqual({ workspaceId: originWorkspace, profileKind: 'personal' });
  await context.close();

  // ── dispositivo B: instala o aplicativo, perde a rede e importa ─────────
  let contextB = await other.open();
  let b = await contextB.newPage();
  await b.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(b);
  await contextB.close();
  await server.stop();
  expect(await isReachable()).toBe(false);
  contextB = await other.open({ offline: true });
  b = await contextB.newPage();
  const requestedBefore = other.requested.length;
  await choosePackage(b, packagePath);
  const preview = b.getByTestId('import-preview');
  await expect(preview).toHaveAttribute('data-same-workspace', 'false');
  await expect(preview).toHaveAttribute('data-copy', '7');
  await expect(preview).toHaveAttribute('data-insert', '0');
  await expect(preview).toHaveAttribute('data-reuse', '0');
  await expect(preview).toHaveAttribute('data-new-media-bytes', String(mediaBytes));
  await expect(preview).toContainText('entra aqui como cópia, com identificadores novos');
  // A prévia não grava nada.
  expect(await counts(b)).toEqual({ songs: 0, arrangements: 0, setlists: 0, assets: 0, blobs: 0 });
  await shot(b, 'pacote-previa-outro-dispositivo');
  await b.getByRole('button', { name: 'Importar', exact: true }).click();
  const imported = b.getByTestId('import-result');
  await expect(imported).toHaveAttribute('data-written', '7');
  await expect(imported).toHaveAttribute('data-media-stored', '2');

  // IDs remapeados, conteúdo e bytes íntegros, nada da sincronização da origem.
  const songsB = await readStore<Stored>(b, 'songs');
  const assetsB = await readStore<StoredAsset>(b, 'assets');
  const everyB = [...songsB, ...assetsB, ...(await readStore<Stored>(b, 'arrangements')), ...(await readStore<Stored>(b, 'setlists'))];
  expect(everyB).toHaveLength(7);
  expect(everyB.filter((row) => originIds.has(row.id))).toEqual([]);
  expect(new Set(everyB.map((row) => row.workspaceId)).size).toBe(1);
  expect(everyB[0]!.workspaceId).not.toBe(originWorkspace);
  expect(songsB.map((song) => song.title).sort()).toEqual(['Em União', 'Manhã de Gratidão']);
  expect(assetsB.map((asset) => asset.sha256).sort()).toEqual(originAssets.map((asset) => asset.sha256).sort());
  expect(assetsB.every((asset) => asset.remoteState === 'local' && asset.storageKey === null)).toBe(true);
  expect((await readStore<{ state: string; verifiedAt: string | null }>(b, 'assetBlobs')).map((row) => [row.state, row.verifiedAt !== null])).toEqual([
    ['ready', true],
    ['ready', true],
  ]);
  const states = await readStore<StoredState>(b, 'entityStates');
  expect(states).toHaveLength(7);
  expect(states.every((state) => state.dirty === 1 && state.serverRevision === null)).toBe(true);
  expect(await readStore(b, 'syncOperations')).toEqual([]);

  // O repertório importado abre, fica pronto para uso offline (bytes relidos e conferidos) e apresenta.
  await imported.getByRole('button', { name: 'Abrir o repertório' }).click();
  await expect(b.getByTestId('setlist-item')).toHaveCount(2);
  await expect(b.getByTestId('setlist-item').nth(0)).toContainText('Em União');
  await expect(b.getByTestId('setlist-item').nth(0)).toContainText('com áudio');
  await b.getByRole('button', { name: 'Preparar para uso offline' }).click();
  await expect(b.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await shot(b, 'pacote-importado-pronto-offline');
  await b.getByRole('button', { name: 'Apresentar Em União' }).click();
  await expect(operator(b)).toHaveAttribute('data-status', 'ready');
  await expect(b.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[0]!);
  await expect(b.locator('audio[data-testid="session-audio"]')).toHaveCount(1);
  // Tudo isso sem um único pedido para fora do dispositivo.
  expect(other.requested.slice(requestedBefore).every((url) => url.startsWith(`${ORIGIN}/`) || /^(blob|data):/.test(url))).toBe(true);

  // ── importação repetida: nada duplica ───────────────────────────────────
  const afterFirst = await counts(b);
  expect(afterFirst).toEqual({ songs: 2, arrangements: 2, setlists: 1, assets: 2, blobs: 2 });
  await choosePackage(b, packagePath);
  await expect(preview).toHaveAttribute('data-reuse', '7');
  await expect(preview).toHaveAttribute('data-copy', '0');
  await expect(preview).toHaveAttribute('data-new-media-bytes', '0');
  await expect(preview).toContainText('Nenhum documento novo');
  await b.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(imported).toHaveAttribute('data-written', '0');
  await expect(imported).toContainText('já estava importado');
  expect(await counts(b)).toEqual(afterFirst);
  await imported.getByRole('button', { name: 'Fechar' }).click();

  // ── pacote adulterado, truncado e de versão incompatível ────────────────
  const mediaEntry = zip.get(`media/${createHash('sha256').update(playback.buffer).digest('hex')}`)!;
  const flipped = Buffer.from(file);
  flipped[mediaEntry.dataOffset + 5000] = flipped[mediaEntry.dataOffset + 5000]! ^ 0xff;
  writeFileSync(join(work, 'adulterado.zip'), flipped);
  await expectRefused(b, join(work, 'adulterado.zip'), 'hash-mismatch', 'corrompido ou foi alterado');
  await shot(b, 'pacote-adulterado-recusado');

  // Quem adultera com cuidado e refaz o CRC esbarra no SHA-256 do manifesto.
  const careful = Buffer.from(flipped);
  const tamperedData = careful.subarray(mediaEntry.dataOffset, mediaEntry.dataOffset + mediaEntry.data.length);
  careful.writeUInt32LE(crc32(tamperedData), mediaEntry.localOffset + 14);
  careful.writeUInt32LE(crc32(tamperedData), mediaEntry.centralOffset + 16);
  writeFileSync(join(work, 'adulterado-crc.zip'), careful);
  await expectRefused(b, join(work, 'adulterado-crc.zip'), 'hash-mismatch', 'corrompido ou foi alterado');

  writeFileSync(join(work, 'truncado.zip'), file.subarray(0, file.length - 700));
  await expectRefused(b, join(work, 'truncado.zip'), 'not-a-package', 'não é um pacote LouvorVisual válido');
  writeFileSync(join(work, 'qualquer.zip'), Buffer.from('apenas um texto com extensão zip'));
  await expectRefused(b, join(work, 'qualquer.zip'), 'not-a-package', 'não é um pacote LouvorVisual válido');

  writeFileSync(join(work, 'formato-novo.zip'), editManifest(file, '"minReaderVersion": 1', '"minReaderVersion": 7'));
  await expectRefused(b, join(work, 'formato-novo.zip'), 'format-too-new', 'versão mais nova do LouvorVisual');
  await shot(b, 'pacote-versao-incompativel');
  writeFileSync(join(work, 'esquema-novo.zip'), editManifest(file, '"schemaVersion": 1', '"schemaVersion": 4'));
  await expectRefused(b, join(work, 'esquema-novo.zip'), 'schema-too-new', 'formato de documento mais novo');
  writeFileSync(join(work, 'fontes-novas.zip'), editManifest(file, '"fontPackVersion": "1"', '"fontPackVersion": "9"'));
  await expectRefused(b, join(work, 'fontes-novas.zip'), 'font-pack-incompatible', 'pacote de fontes');
  expect(await counts(b)).toEqual(afterFirst);
  await contextB.close();
  expect(other.consoleErrors).toEqual([]);

  // ── dispositivo A, mesmo espaço: o pacote não sobrescreve o que mudou aqui ─
  context = await profile.open({ offline: true });
  page = await context.newPage();
  await page.goto(`${ORIGIN}/app`);
  await page.getByRole('link', { name: 'Em União' }).click();
  await page.getByLabel('Título').fill('Em União (versão do ensaio)');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  const before = await counts(page);
  await choosePackage(page, packagePath);
  const previewA = page.getByTestId('import-preview');
  await expect(previewA).toHaveAttribute('data-same-workspace', 'true');
  await expect(previewA).toHaveAttribute('data-insert', '0');
  expect(Number(await previewA.getAttribute('data-diverged'))).toBeGreaterThan(0);
  await expect(page.getByTestId('import-diverged')).toContainText('Nada é substituído');
  await expect(previewA).toHaveAttribute('data-new-media-bytes', '0');
  await shot(page, 'pacote-previa-mesmo-espaco-com-divergencia');
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByTestId('import-result')).toBeVisible();
  const songsA = await readStore<Stored>(page, 'songs');
  // O louvor editado aqui continua como estava; o do pacote entrou ao lado, identificado.
  expect(songsA.map((song) => song.title).sort()).toEqual(['Em União (importado)', 'Em União (versão do ensaio)', 'Manhã de Gratidão']);
  expect(songsA.find((song) => song.title === 'Em União (versão do ensaio)')!.id).toBe(originSongs.find((song) => song.title === 'Em União')!.id);
  expect((await readStore<Stored>(page, 'setlists')).map((setlist) => setlist.title).sort()).toEqual(['Culto de domingo', 'Culto de domingo (importado)']);
  // Os áudios não foram duplicados.
  expect(await counts(page)).toMatchObject({ assets: before.assets, blobs: before.blobs, songs: before.songs + 1, setlists: before.setlists + 1 });
  await context.close();
  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('lixeira e histórico: excluir, fechar tudo, reabrir sem rede, restaurar o louvor e voltar a uma versão anterior', async () => {
  test.setTimeout(180_000);
  let context = await profile.open();
  let page = await context.newPage();
  await createSong(page, { title: 'Manhã de Gratidão', durations: ['4', null], install: true });
  const [song] = await readStore<Stored & { rawLyrics: string }>(page, 'songs');
  // Uma edição: a versão anterior vai para o histórico.
  await page.getByLabel('Título').fill('Manhã de Gratidão (rascunho ruim)');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await page.getByRole('button', { name: 'Excluir Manhã de Gratidão (rascunho ruim)' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('vão para a lixeira');
  await page.getByRole('button', { name: 'Mover para a lixeira' }).click();
  await expect(page.getByTestId('library-empty')).toBeVisible();
  await context.close();

  await server.stop();
  context = await profile.open({ offline: true });
  page = await context.newPage();
  const response = await page.goto(`${ORIGIN}/app?view=lixeira`);
  expect(response?.fromServiceWorker()).toBe(true);
  const item = page.getByTestId('trash-item');
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute('data-type', 'song');
  await expect(item).toContainText('Manhã de Gratidão (rascunho ruim)');
  await expect(item).toContainText('1 arranjo volta junto');
  await shot(page, 'lixeira-com-louvor');
  await page.getByRole('button', { name: 'Restaurar Manhã de Gratidão (rascunho ruim)' }).click();
  await expect(page.getByTestId('trash-message')).toContainText('voltou para a biblioteca');
  await expect(page.getByTestId('trash-empty')).toBeVisible();

  // Histórico: a versão de antes da edição e a de antes da exclusão.
  const beforeEdit = page.locator('[data-testid="history-item"][data-type="song"][data-reason="edit"]');
  await expect(beforeEdit).toHaveCount(1);
  await expect(beforeEdit).toContainText('Manhã de Gratidão');
  await expect(beforeEdit).toHaveAttribute('data-current', 'false');
  await shot(page, 'historico-versoes');
  await beforeEdit.getByRole('button', { name: /Restaurar a versão/ }).click();
  await expect(page.getByTestId('trash-message')).toContainText('A versão que estava em uso foi guardada');
  await expect(page.locator('[data-testid="history-item"][data-reason="restore"]')).toHaveCount(1);

  const [restored] = await readStore<Stored & { rawLyrics: string }>(page, 'songs');
  expect(restored).toMatchObject({ id: song!.id, title: 'Manhã de Gratidão', deletedAt: null, rawLyrics: song!.rawLyrics });
  const arrangements = await readStore<Stored & { occurrences: { durationMs: number | null }[] }>(page, 'arrangements');
  expect(arrangements).toHaveLength(1);
  expect(arrangements[0]).toMatchObject({ deletedAt: null });
  expect(arrangements[0]!.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([4000, null]);

  // O louvor restaurado abre no editor e apresenta, ainda sem rede.
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await expect(page.getByTestId('library-item')).toHaveCount(1);
  await page.getByRole('link', { name: 'Manhã de Gratidão' }).click();
  await expect(page.getByTestId('occurrence')).toHaveCount(2);
  await openOperator(page);
  await expect(page.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[0]!);
  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

test('AT-21: atualização chega durante a apresentação — nenhuma recarga, nenhum recurso removido, e a versão nova só entra depois de encerrar', async () => {
  test.setTimeout(240_000);
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['30', '30', null], install: true });
  await openOperator(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático' }).first().click();
  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  const sessionId = await operator(page).getAttribute('data-session-id');
  // Marcas na memória de cada janela: somem se a página recarregar.
  for (const window of [page, projection]) await window.evaluate(() => ((globalThis as unknown as { lvMarker: string }).lvMarker = 'mesma-pagina'));
  const marker = (window: Page) => window.evaluate(() => (globalThis as unknown as { lvMarker?: string }).lvMarker);
  const oldCache = `lv-precache-${currentVersion}`;
  const oldEntries = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).length, oldCache);

  // ── a versão nova é publicada e o navegador a encontra no meio do culto ─
  const nextVersion = publishServiceWorker({ salt: 'e2e-durante-o-culto' });
  expect(nextVersion).not.toBe(currentVersion);
  const waiting = await page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration())!;
    await registration.update();
    for (let tries = 0; tries < 200 && !registration.waiting; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return Boolean(registration.waiting);
  });
  expect(waiting).toBe(true);
  expect((await cacheNames(page)).sort()).toEqual([oldCache, `lv-precache-${nextVersion}`].sort());

  // Nada mudou para quem está apresentando.
  expect(await marker(page)).toBe('mesma-pagina');
  expect(await marker(projection)).toBe('mesma-pagina');
  expect((await waitUntilInstalled(page)).version).toBe(currentVersion);
  expect((await waitUntilInstalled(projection)).version).toBe(currentVersion);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  expect(await operator(page).getAttribute('data-session-id')).toBe(sessionId);
  expect(await page.evaluate(async (name) => (await (await caches.open(name)).keys()).length, oldCache)).toBe(oldEntries);
  // Nenhum aviso de atualização na área do operador nem na saída pública.
  await expect(page.getByTestId('update-waiting')).toHaveCount(0);
  await expect(projection.getByTestId('update-waiting')).toHaveCount(0);
  await expect(page.getByTestId('data-notice')).toHaveCount(0);

  // Em outra janela, pedir a atualização é recusado — com a projeção aberta…
  const admin = await context.newPage();
  await admin.goto(`${ORIGIN}/app?view=offline`);
  await expect(admin.getByTestId('app-version')).toHaveText(currentVersion);
  await expect(admin.getByTestId('update-waiting')).toBeVisible();
  await admin.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(admin.getByTestId('update-blocked')).toContainText('apresentação em andamento');
  await shot(admin, 'atualizacao-recusada-durante-apresentacao');
  // …e também só com a área do operador (a janela pública fechou, o culto continua).
  await projection.close();
  await admin.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(admin.getByTestId('update-blocked')).toContainText('apresentação em andamento');
  await expect(admin.getByTestId('app-version')).toHaveText(currentVersion);

  // A apresentação segue operável com os recursos da versão em uso: avança, reabre a projeção.
  await page.getByTestId('advance').click();
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  const reopened = await openProjection(context, page);
  expect((await waitUntilInstalled(reopened)).version).toBe(currentVersion);
  await expect(reopened.locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[1]!);
  expect(await marker(page)).toBe('mesma-pagina');
  expect(await cacheNames(page)).toHaveLength(2);
  await shot(page, 'apresentacao-segue-com-atualizacao-pendente');

  // ── encerrada a sessão, a atualização entra a pedido e os dados continuam ─
  await reopened.close();
  await page.close();
  await admin.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(admin.getByTestId('app-version')).toHaveText(nextVersion);
  await expect.poll(() => cacheNames(admin)).toEqual([`lv-precache-${nextVersion}`]);
  await expect(admin.getByTestId('local-data')).toHaveAttribute('data-songs', '1');
  const sessions = await readStore<{ id: string; status: string }>(admin, 'presentationSessions');
  expect(sessions.find((row) => row.id === sessionId)).toBeDefined();
  // A sessão interrompida pelo fechamento da janela é oferecida em pausa, já na versão nova.
  await admin.goto(`${ORIGIN}/app`);
  await admin.getByRole('button', { name: 'Apresentar Em União' }).click();
  await expect(admin.getByTestId('recover-prompt')).toContainText('Em União');
  await admin.getByRole('button', { name: 'Recuperar apresentação' }).click();
  await expect(operator(admin)).toHaveAttribute('data-status', 'paused');
  await expect(operator(admin)).toHaveAttribute('data-index', '1');
  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

test('AT-22: pacote que não cabe no dispositivo não deixa nada importado, e mídia corrompida é apontada e recuperada pelo pacote', async () => {
  test.setTimeout(300_000);
  // Origem: um repertório com uma faixa de ~10 MB.
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { title: 'Em União', durations: [null, null], install: true });
  const big = wavFile('uniao-playback.wav', 630, 440);
  expect(big.buffer.length).toBeGreaterThan(10_000_000);
  await importAudio(page, 'playback', big);
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByLabel('Nome do repertório').fill('Culto de domingo');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  await page.getByLabel('Acrescentar louvor').selectOption({ label: 'Em União — Culto' });
  await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
  await expect(page.getByTestId('setlist-item')).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar pacote' }).click()]);
  const packagePath = join(work, download.suggestedFilename());
  await download.saveAs(packagePath);

  // ── mídia corrompida na origem: a conferência aponta, o pacote não finge, a importação conserta ─
  expect(await tamperAudioBlobs(page, 'corrupt')).toBe(1);
  await page.goto(`${ORIGIN}/app?view=offline`);
  await page.getByRole('button', { name: 'Conferir também os áudios (lê cada arquivo)' }).click();
  await expect(page.getByTestId('integrity-report')).toHaveAttribute('data-problems', '1');
  await expect(page.getByTestId('integrity-media')).toHaveAttribute('data-issue', 'corrupted');
  await expect(page.getByTestId('integrity-media')).toContainText('uniao-playback.wav: o arquivo guardado está diferente do original. Usado em Em União');
  await shot(page, 'conferencia-audio-corrompido');
  await page.goto(`${ORIGIN}/app?view=repertorios`);
  await page.getByRole('link', { name: 'Culto de domingo' }).click();
  const [partial] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar pacote' }).click()]);
  await expect(page.getByTestId('package-export-result')).toHaveAttribute('data-unavailable', '1');
  await expect(page.getByTestId('package-export-result')).toHaveAttribute('data-media', '0');
  await expect(page.getByTestId('package-export-result')).toContainText('1 faixa não entrou no pacote');
  const partialManifest = JSON.parse(readStoredZip(readFileSync(await partial.path())).get('manifest.json')!.data.toString('utf8'));
  expect(partialManifest.omittedMedia).toMatchObject([{ reason: 'unavailable' }]);
  // O pacote íntegro, exportado antes, devolve os bytes certos.
  await choosePackage(page, packagePath);
  await expect(page.getByTestId('import-preview')).toHaveAttribute('data-reuse', '4');
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByTestId('import-result')).toHaveAttribute('data-media-stored', '1');
  await page.goto(`${ORIGIN}/app?view=offline`);
  await page.getByRole('button', { name: 'Conferir também os áudios (lê cada arquivo)' }).click();
  await expect(page.getByTestId('integrity-report')).toHaveAttribute('data-problems', '0');
  await expect(page.getByTestId('integrity-report')).toHaveAttribute('data-media-verified', 'true');
  await context.close();

  // ── destino com pouco espaço: quota reduzida antes do primeiro uso ──────
  const browser = await chromium.launch();
  const small = await browser.newContext();
  const consoleErrors: string[] = [];
  small.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const target = await small.newPage();
  const cdp = await small.newCDPSession(target);
  // Cabe o aplicativo e um louvor; não cabe a faixa de 10 MB do pacote.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN, quotaSize: 6_000_000 });
  await createSong(target, { title: 'Já estava aqui', durations: [null] });
  const before = { ...(await counts(target)), states: (await readStore(target, 'entityStates')).length, map: (await readStore(target, 'importMap')).length };
  await choosePackage(target, packagePath);
  await expect(target.getByTestId('import-preview')).toHaveAttribute('data-copy', '4');
  await target.getByRole('button', { name: 'Importar', exact: true }).click();
  const error = target.getByTestId('import-error');
  await expect(error).toHaveAttribute('data-code', 'quota');
  await expect(error).toContainText('Não há espaço neste dispositivo para o pacote. Nada foi importado');
  await shot(target, 'pacote-sem-espaco');
  // Nenhum falso "importado": nem documentos, nem bytes parciais, nem mapa de importação.
  expect({ ...(await counts(target)), states: (await readStore(target, 'entityStates')).length, map: (await readStore(target, 'importMap')).length }).toEqual(before);
  await target.goto(`${ORIGIN}/app`);
  await expect(target.getByTestId('library-item')).toHaveCount(1);
  await expect(target.getByTestId('library-item')).toContainText('Já estava aqui');

  // Recuperação acionável: com espaço de volta, a mesma importação conclui.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN });
  await expect(async () => {
    await choosePackage(target, packagePath);
    await expect(target.getByTestId('import-preview')).toBeVisible();
    await target.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(target.getByTestId('import-result')).toHaveAttribute('data-media-stored', '1', { timeout: 15_000 });
  }).toPass({ timeout: 120_000, intervals: [5000] });
  expect(await counts(target)).toEqual({ songs: 2, arrangements: 2, setlists: 1, assets: 1, blobs: 1 });
  expect(consoleErrors.filter((message) => !/quota/i.test(message))).toEqual([]);
  await browser.close();
  expect(profile.consoleErrors).toEqual([]);
});

// Medição, não aceite: quanto de memória e tempo um pacote grande custa neste
// equipamento (planejamento/17: o teto do pacote sai de uma prova de memória).
// Roda só a pedido: LV_PACKAGE_MB=95 npx playwright test e2e/recovery.spec.ts -g medição
const PROBE_MB = Number(process.env.LV_PACKAGE_MB ?? 0);

test('medição: memória e tempo ao exportar e importar um pacote grande', async () => {
  test.skip(!PROBE_MB, 'Defina LV_PACKAGE_MB (por exemplo, 95) para medir.');
  test.setTimeout(900_000);
  const { readFileSync: read } = await import('node:fs');
  const { wavBytes } = await import('../src/lib/testAudio');
  const audioPath = join(work, 'faixa-grande.wav');
  writeFileSync(audioPath, wavBytes(Math.floor((PROBE_MB * 1024 * 1024 - 44) / 16_000)));
  const audioBytes = read(audioPath).length;

  const browser = await chromium.launch();
  const system = await browser.newBrowserCDPSession();
  /** Memória residente dos processos de página: atual e pico desde que cada um nasceu, em MiB. */
  const memory = async () => {
    const { processInfo } = (await system.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
    let rss = 0;
    let peak = 0;
    for (const { type, id } of processInfo) {
      if (type !== 'renderer') continue;
      const status = read(`/proc/${id}/status`, 'utf8');
      rss = Math.max(rss, Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
      peak = Math.max(peak, Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
    }
    return { rss: Math.round(rss), peak: Math.round(peak) };
  };
  /** Zera o pico registrado pelo kernel, para medir só a etapa seguinte. */
  const resetPeak = async () => {
    const { processInfo } = (await system.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
    for (const { type, id } of processInfo) if (type === 'renderer') writeFileSync(`/proc/${id}/clear_refs`, '5');
  };

  // Origem: importa a faixa, monta o repertório e exporta.
  const source = await (await browser.newContext()).newPage();
  await createSong(source, { title: 'Em União', durations: [null, null] });
  await source.getByTestId('audio-import-playback').locator('input[type="file"]').setInputFiles(audioPath);
  await source.getByTestId('audio-import-playback').getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(source.getByTestId('audio-playback')).toHaveAttribute('data-state', 'bound', { timeout: 300_000 });
  await source.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(source, 'repertorios');
  await source.getByLabel('Nome do repertório').fill('Pacote grande');
  await source.getByRole('button', { name: 'Criar repertório' }).click();
  await source.getByLabel('Acrescentar louvor').selectOption({ label: 'Em União — Culto' });
  await source.getByRole('button', { name: 'Acrescentar', exact: true }).click();
  await expect(source.getByTestId('setlist-item')).toHaveCount(1);
  // O pico medido a seguir é o da exportação, não o da importação do áudio.
  await resetPeak();
  const beforeExport = await memory();
  let started = Date.now();
  const [download] = await Promise.all([source.waitForEvent('download', { timeout: 300_000 }), source.getByRole('button', { name: 'Exportar pacote' }).click()]);
  const packagePath = join(work, download.suggestedFilename());
  await download.saveAs(packagePath);
  const exportMs = Date.now() - started;
  const afterExport = await memory();
  const packageBytes = read(packagePath).length;
  await source.context().close();

  // Destino: contexto novo, confere e importa.
  const target = await (await browser.newContext()).newPage();
  await target.goto(`${ORIGIN}/app?view=repertorios`);
  await expect(target.getByTestId('package-import')).toBeVisible();
  await resetPeak();
  const beforeImport = await memory();
  started = Date.now();
  await target.locator('#pacote-arquivo').setInputFiles(packagePath);
  await expect(target.getByTestId('import-preview')).toBeVisible({ timeout: 300_000 });
  const checkMs = Date.now() - started;
  started = Date.now();
  await target.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(target.getByTestId('import-result')).toHaveAttribute('data-media-stored', '1', { timeout: 300_000 });
  const applyMs = Date.now() - started;
  const afterImport = await memory();
  await browser.close();

  const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const report = {
    audioMiB: mib(audioBytes),
    packageMiB: mib(packageBytes),
    export: { ms: exportMs, rssBeforeMiB: beforeExport.rss, peakMiB: afterExport.peak },
    import: { checkMs, applyMs, rssBeforeMiB: beforeImport.rss, peakMiB: afterImport.peak },
  };
  writeFileSync(join(EVIDENCE, 'medicao-pacote.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  // Só o que o formato garante: sem compressão, o pacote é o áudio mais alguns KiB.
  expect(packageBytes - audioBytes).toBeLessThan(64 * 1024);
});
