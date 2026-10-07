import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { audioState, chooseAudio, expectAudioPlaying, importAudio, mp3File, setPolicy, tamperAudioBlobs, waitAudioAt, watchAudio, wavFile } from './audio.helpers';
import { BrowserProfile, isReachable, openHiddenView, ORIGIN, ProductionServer } from './helpers';
import { createSong, drawn, expectConfirmed, mediaElements, openOperator, openProjection, operator, output, readStore, SLIDE_TEXTS, startShow } from './presentation.helpers';

const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '07-evidencias');

type StoredArrangement = { id: string; audioBindings: { id: string; policy: string; offsetMs: number; cues: { startMs: number; endMs: number }[]; assetId: string }[]; selectedAudioBindingId: string | null; occurrences: { durationMs: number | null }[] };
type StoredAsset = { id: string; sha256: string; byteSize: number; filename: string; durationMs: number; mimeType: string };
type StoredBlob = { key: string; state: string; byteSize: number; sha256: string };

const server = new ProductionServer();
let profile: BrowserProfile;

test.beforeEach(async () => {
  profile = new BrowserProfile();
  await server.start();
});

test.afterEach(async () => {
  await server.stop();
  profile.remove();
});

const thumbnail = (page: Page, index: number) => page.getByTestId('thumbnail').nth(index);

test('AT-07 (independente), AT-08 e AT-28: player único, sem seek ao trocar de slide, play/pause com faixa e sem temporizador', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: [null, null, null] });

  // ── importação: tamanho antes de importar, identidade pelo hash, bytes guardados ──
  const file = wavFile('playback-uniao.wav', 40);
  await chooseAudio(page, 'playback', file);
  await expect(page.getByTestId('audio-chosen-size')).toHaveText('0,6 MB');
  expect(await readStore(page, 'assets')).toEqual([]);
  await page.getByTestId('audio-import-playback').getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByTestId('audio-playback').getByTestId('audio-track')).toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('audio-playback').getByTestId('audio-duration')).toHaveAttribute('data-duration-ms', '40000');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const [asset] = await readStore<StoredAsset>(page, 'assets');
  expect(asset).toMatchObject({ filename: 'playback-uniao.wav', byteSize: file.buffer.length, durationMs: 40_000, mimeType: 'audio/wav' });
  expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readStore<StoredBlob>(page, 'assetBlobs')).toMatchObject([{ state: 'ready', byteSize: file.buffer.length, sha256: asset!.sha256 }]);
  const [stored] = await readStore<StoredArrangement>(page, 'arrangements');
  expect(stored).toMatchObject({ audioBindings: [{ policy: 'independent', assetId: asset!.id, cues: [] }] });
  expect(stored!.selectedAudioBindingId).toBe(stored!.audioBindings[0]!.id);
  // Sem tempo nos slides, o vínculo não é oferecido.
  await expect(page.getByTestId('audio-playback').getByTestId('link-issues')).toContainText('Todos os slides precisam de tempo');
  await expect(page.getByTestId('audio-playback').getByLabel('Relação com os slides').locator('option[value="linked"]')).toBeDisabled();
  // Na página do editor não existe player de sessão.
  expect(await mediaElements(page)).toBe(0);

  // ── operador: um único player; a janela pública não tem nenhum ──────────
  await openOperator(page);
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'independent');
  await expect(page.getByTestId('audio-panel')).toContainText('playback-uniao.wav');
  // Antes de iniciar, o operador escolhe a faixa da sessão: sem áudio não há player; de volta ao playback, há um só.
  await page.getByTestId('audio-panel').getByLabel('Sem áudio').check();
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'none');
  await expect(page.getByTestId('audio-none')).toBeVisible();
  expect(await mediaElements(page)).toBe(0);
  await page.getByTestId('audio-panel').getByLabel('Playback').check();
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'independent');
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await watchAudio(page);
  const projection = await openProjection(context, page);
  expect(await mediaElements(page)).toBe(1);
  expect(await mediaElements(projection)).toBe(0);

  // Antes de iniciar: teste de som; iniciar volta ao ponto de partida.
  await page.getByTestId('audio-toggle').click();
  await waitAudioAt(page, 600);
  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  // Iniciar toca a faixa desde o ponto de partida, também no manual.
  await expectAudioPlaying(page, true);

  // AT-28: sem temporizador, o play/pause existe porque há faixa; o indicador de tempo, não.
  await expect(page.getByTestId('transport')).toBeVisible();
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await expect(page.getByTestId('countdown')).toHaveCount(0);

  await waitAudioAt(page, 1000);
  const before = await audioState(page);

  // ── AT-07: trocar de slide por botão, teclado, miniatura e pela janela pública não faz seek ──
  await page.getByTestId('advance').click();
  await page.keyboard.press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  await thumbnail(page, 0).click();
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await projection.bringToFront();
  await projection.keyboard.press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await page.bringToFront();
  await waitAudioAt(page, before.positionMs + 1500);
  const after = await audioState(page);
  expect(after.seeking).toBe(before.seeking);
  expect(after.paused).toBe(false);
  expect(after.positionMs).toBeGreaterThan(before.positionMs);

  // AT-29: ajustes ao vivo e saída visual não pausam nem reposicionam.
  await page.locator('[data-theme="vinho"]').click();
  await page.locator('[data-font="lato"]').click();
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  await page.keyboard.press('c');
  await page.keyboard.press('c');
  await expectConfirmed(page, projection);
  const adjusted = await audioState(page);
  expect(adjusted.seeking).toBe(before.seeking);
  expect(adjusted.paused).toBe(false);
  expect(adjusted.positionMs).toBeGreaterThan(after.positionMs);

  // Sem relógio de slide, não há apresentação a pausar: o play/pause age só na faixa.
  await expect(page.getByTestId('transport')).toHaveText('❚❚ Pausar faixa');
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expectAudioPlaying(page, false);
  const paused = (await audioState(page)).positionMs;
  await page.waitForTimeout(700);
  expect((await audioState(page)).positionMs).toBe(paused);
  await expect(page.getByTestId('transport')).toHaveText('▶ Tocar faixa');
  await page.keyboard.press(' ');
  await expectAudioPlaying(page, true);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');

  // Com tempo no slide e automático, "Pausar" é da apresentação e leva a faixa junto (preferência inicial).
  const liveMenu = page.getByRole('complementary', { name: 'Ajustes ao vivo' });
  await liveMenu.getByRole('button', { name: 'Adicionar tempo ao slide atual' }).click();
  await liveMenu.getByLabel('Tempo do slide atual, em segundos').fill('60');
  await liveMenu.getByLabel('Tempo do slide atual, em segundos').press('Enter');
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
  await expect(page.getByTestId('countdown').first()).toBeVisible();
  await expect(page.getByTestId('transport')).toHaveText('❚❚ Pausar');
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expectAudioPlaying(page, false);
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expectAudioPlaying(page, true);
  // Transporte separado: a apresentação pausa e a faixa continua.
  await page.getByLabel('Pausar a faixa junto com a apresentação').uncheck();
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expectAudioPlaying(page, true);
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await page.getByLabel('Pausar a faixa junto com a apresentação').check();
  // Remover o tempo não esconde o transporte de uma faixa existente.
  await liveMenu.getByRole('button', { name: 'Remover tempo do slide atual' }).click();
  await page.getByRole('button', { name: 'Manual', exact: true }).first().click();
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await expect(page.getByTestId('transport')).toHaveText('❚❚ Pausar faixa');
  expect((await audioState(page)).seeking).toBe(before.seeking);

  // Modo interativo: o play/pause compacto aparece por causa da faixa e controla o mesmo player.
  await page.getByRole('button', { name: 'Modo interativo' }).click();
  await expect(page.getByTestId('corner-transport')).toBeVisible();
  await expect(page.getByTestId('corner-timer')).toHaveCount(0);
  await page.getByTestId('corner-transport').click();
  await expectAudioPlaying(page, false);
  await page.getByTestId('corner-transport').click();
  await expectAudioPlaying(page, true);
  expect(await mediaElements(page)).toBe(1);
  await page.screenshot({ path: join(EVIDENCE, 'interativo-faixa-sem-temporizador.png') });
  await page.getByRole('button', { name: 'Painel completo' }).click();

  // Controles na janela pública: o pedido vai ao player do operador; a saída continua sem mídia.
  await projection.bringToFront();
  await projection.keyboard.press('m');
  await projection.getByLabel('Mostrar controles nesta tela').check();
  await projection.getByRole('button', { name: 'Fechar preparação' }).click();
  await projection.mouse.move(300, 300);
  await projection.getByTestId('corner-menu').click();
  await expect(projection.getByTestId('menu-audio-track')).toContainText('playback-uniao.wav');
  await projection.getByTestId('menu-audio-toggle').click();
  await expect(operator(page)).toHaveAttribute('data-audio-playing', 'false');
  await projection.getByTestId('menu-audio-toggle').click();
  await expect(operator(page)).toHaveAttribute('data-audio-playing', 'true');
  expect(await mediaElements(projection)).toBe(0);
  expect(await mediaElements(page)).toBe(1);
  await projection.getByTestId('corner-menu').click();
  await page.bringToFront();

  // Volume e posição pelo painel.
  await page.getByTestId('audio-volume').fill('0.3');
  await expect.poll(async () => (await audioState(page)).volume).toBeCloseTo(0.3, 5);
  await page.getByTestId('audio-seek').focus();
  await page.getByTestId('audio-seek').fill('20000');
  await page.getByTestId('audio-seek').blur();
  await expect.poll(async () => (await audioState(page)).positionMs).toBeGreaterThanOrEqual(20_000);
  expect((await audioState(page)).positionMs).toBeLessThan(23_000);
  await page.screenshot({ path: join(EVIDENCE, 'operador-faixa-independente.png') });

  // Parar interrompe a faixa e volta ao estado preparado; encerrar descarta o player.
  await page.getByRole('button', { name: '■ Parar' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await expectAudioPlaying(page, false);
  await expect.poll(async () => (await audioState(page)).positionMs).toBe(0);
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  expect(await mediaElements(page)).toBe(0);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('AT-07 (vinculada): os slides acompanham a posição da faixa e os saltos reposicionam com confirmação', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['3', '4', '3'] });
  await importAudio(page, 'playback', wavFile('playback.wav', 20));
  // Deslocamento de 2 s: intervalos 2–5, 5–9 e 9–12 s da gravação.
  await setPolicy(page, 'playback', 'linked', '2');
  await expect(page.getByTestId('audio-playback').getByTestId('link-ok')).toContainText('0:02 a 0:12');
  const [stored] = await readStore<StoredArrangement>(page, 'arrangements');
  expect(stored!.audioBindings[0]).toMatchObject({ policy: 'linked', offsetMs: 2000, cues: [{ startMs: 2000, endMs: 5000 }, { startMs: 5000, endMs: 9000 }, { startMs: 9000, endMs: 12_000 }] });

  // AT-03: editar tempos revalida os intervalos; um slide sem tempo desfaz o vínculo em vez de salvar algo inválido.
  const cards = page.getByTestId('occurrence');
  await cards.nth(1).getByRole('button', { name: 'Remover tempo do slide 2' }).click();
  await expect(page.getByTestId('editor-notice')).toContainText('a faixa deixou de estar vinculada');
  await expect(page.getByTestId('audio-playback').getByTestId('audio-track')).toHaveAttribute('data-policy', 'independent');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect((await readStore<StoredArrangement>(page, 'arrangements'))[0]!.audioBindings[0]).toMatchObject({ policy: 'independent', cues: [] });
  await page.getByRole('button', { name: '↶ Desfazer' }).click();
  await expect(page.getByTestId('audio-playback').getByTestId('audio-track')).toHaveAttribute('data-policy', 'linked');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect((await readStore<StoredArrangement>(page, 'arrangements'))[0]!.audioBindings[0]).toMatchObject({ policy: 'linked', cues: [{ startMs: 2000, endMs: 5000 }, { startMs: 5000, endMs: 9000 }, { startMs: 9000, endMs: 12_000 }] });
  // Tempos que passam do fim da gravação (20 s): o vínculo fica impedido e o editor diz por quê.
  await cards.nth(2).getByRole('button', { name: /Alterar tempo do slide 3/ }).click();
  await cards.nth(2).getByLabel('Tempo do slide 3, em segundos').fill('30');
  await cards.nth(2).getByLabel('Tempo do slide 3, em segundos').press('Enter');
  await expect(page.getByTestId('audio-playback').getByTestId('link-issues')).toContainText('passam do fim da gravação');
  await page.getByRole('button', { name: '↶ Desfazer' }).click();
  await expect(page.getByTestId('audio-playback').getByTestId('link-ok')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await openOperator(page);
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'linked');
  await watchAudio(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
  await expect(operator(page)).toHaveAttribute('data-clock-source', 'audio');

  // ── automático vinculado: a faixa é o relógio ───────────────────────────
  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expectAudioPlaying(page, true);
  expect((await audioState(page)).positionMs).toBeGreaterThanOrEqual(2000);
  expect((await audioState(page)).positionMs).toBeLessThan(2600);
  await expect(page.getByTestId('countdown')).toBeVisible();

  await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 20_000 });
  const run = await audioState(page);
  const toSecond = run.log.find((entry) => entry.index === 1)!;
  const toThird = run.log.find((entry) => entry.index === 2)!;
  const finished = run.log.find((entry) => entry.status === 'finished')!;
  // Cada troca acontece quando a faixa cruza o início do intervalo (tolerância de 200 ms).
  const deviations = [toSecond.audioMs - 5000, toThird.audioMs - 9000, finished.audioMs - 12_000];
  for (const deviation of deviations) {
    expect(deviation).toBeGreaterThanOrEqual(-20);
    expect(deviation).toBeLessThanOrEqual(200);
  }
  console.log(`AT-07 desvio da troca em relação à posição da faixa (ms): ${deviations.map((value) => Math.round(value)).join(', ')}`);
  // Fim planejado: último slide na tela e faixa parada ali, com gravação sobrando.
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  expect(run.paused).toBe(true);
  expect(run.ended).toBe(false);
  expect(run.positionMs).toBeGreaterThanOrEqual(12_000);
  expect(run.positionMs).toBeLessThan(12_300);
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[2]);

  // ── salto em execução: reposiciona no início do destino e continua ──────
  const seeksBefore = (await audioState(page)).seeking;
  await thumbnail(page, 0).click();
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expect(operator(page)).toHaveAttribute('data-audio-seeking', 'false');
  let state = await audioState(page);
  expect(state.seeking).toBe(seeksBefore + 1);
  expect(state.positionMs).toBeGreaterThanOrEqual(2000);
  expect(state.positionMs).toBeLessThan(2700);
  await expectAudioPlaying(page, true);

  await page.waitForTimeout(800);
  await thumbnail(page, 2).click();
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  state = await audioState(page);
  expect(state.positionMs).toBeGreaterThanOrEqual(9000);
  expect(state.positionMs).toBeLessThan(9700);
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[2]);

  // Saltos rápidos: vale o último destino.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(operator(page)).toHaveAttribute('data-audio-seeking', 'false');
  const settled = Number(await operator(page).getAttribute('data-index'));
  const starts = [2000, 5000, 9000];
  state = await audioState(page);
  expect(state.positionMs).toBeGreaterThanOrEqual(starts[settled]!);
  expect(state.positionMs).toBeLessThan(starts[settled]! + 800);

  // ── em pausa: o salto fica parado exatamente no início do destino ───────
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expectAudioPlaying(page, false);
  await thumbnail(page, 1).click();
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await page.waitForTimeout(600);
  state = await audioState(page);
  expect(state.positionMs).toBe(5000);
  expect(state.paused).toBe(true);
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');

  // ── manual vinculado: a faixa não passa slides e toca além da duração visual ──
  await page.getByRole('button', { name: 'Manual', exact: true }).first().click();
  await expect(operator(page)).toHaveAttribute('data-clock-source', 'monotonic');
  await expect(page.getByTestId('linked-manual-hint')).toBeVisible();
  await page.getByTestId('transport').click();
  await expectAudioPlaying(page, true);
  // O slide 2 vai de 5 a 9 s; a faixa passa de 9,5 s e o slide continua o mesmo.
  await waitAudioAt(page, 9500);
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await page.getByTestId('advance').click();
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  state = await audioState(page);
  expect(state.positionMs).toBeGreaterThanOrEqual(9000);
  expect(state.positionMs).toBeLessThan(9700);
  // De volta ao automático: os slides seguem a posição em que a faixa está, sem novo seek.
  const seeksManual = state.seeking;
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
  await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 10_000 });
  expect((await audioState(page)).seeking).toBe(seeksManual);
  await page.screenshot({ path: join(EVIDENCE, 'operador-faixa-vinculada.png') });

  expect(await mediaElements(page)).toBe(1);
  expect(await mediaElements(projection)).toBe(0);
  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

test('AT-31: rascunho de tempo com faixa vinculada não faz seek; aplicar pede pausa e revalida; remover tempo oferece desvincular', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['6', '6', '6'] });
  await importAudio(page, 'playback', wavFile('playback.wav', 30));
  await setPolicy(page, 'playback', 'linked', '1');

  await openOperator(page);
  await watchAudio(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
  await startShow(page);
  await expectAudioPlaying(page, true);
  await waitAudioAt(page, 1500);

  // O campo de tempo direto não existe com a faixa vinculada; no lugar, a revisão.
  const menu = page.getByRole('complementary', { name: 'Ajustes ao vivo' });
  await expect(menu.getByTestId('linked-timing')).toBeVisible();
  await expect(menu.getByTestId('timer')).toHaveCount(0);

  // ── rascunho: digitar não toca na música nem na apresentação ────────────
  const before = await audioState(page);
  const sequenceBefore = await operator(page).getAttribute('data-sequence');
  await menu.getByRole('button', { name: 'Revisar tempos…' }).click();
  const draft = menu.getByTestId('linked-timing-draft');
  await draft.getByLabel('Tempo do slide 1, em segundos').fill('4');
  await draft.getByLabel('Tempo do slide 2, em segundos').pressSequentially('0', { delay: 80 });
  await draft.getByLabel('Tempo do slide 2, em segundos').fill('5,5');
  await expect(draft.getByTestId('linked-interval').nth(0)).toHaveText('0:01–0:05');
  await expect(draft.getByTestId('linked-interval').nth(1)).toHaveText('0:05–0:10');
  await page.waitForTimeout(500);
  const typing = await audioState(page);
  expect(typing.seeking).toBe(before.seeking);
  expect(typing.paused).toBe(false);
  expect(typing.positionMs).toBeGreaterThan(before.positionMs);
  expect(await operator(page).getAttribute('data-sequence')).toBe(sequenceBefore);
  await expect(thumbnail(page, 0).getByTestId('thumbnail-duration')).toHaveAttribute('data-duration-ms', '6000');

  // ── aplicar pede pausa ──────────────────────────────────────────────────
  await expect(draft.getByTestId('linked-needs-pause')).toBeVisible();
  await expect(draft.getByRole('button', { name: 'Aplicar tempos revisados' })).toBeDisabled();
  await draft.getByRole('button', { name: '❚❚ Pausar para aplicar' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expectAudioPlaying(page, false);
  const pausedAt = (await audioState(page)).positionMs;

  // ── revalidação: intervalos além da gravação não são aceitos ────────────
  await draft.getByLabel('Tempo do slide 3, em segundos').fill('60');
  await expect(draft.getByTestId('linked-beyond')).toContainText('1:10');
  await expect(draft.getByRole('button', { name: 'Aplicar tempos revisados' })).toBeDisabled();
  await draft.getByLabel('Tempo do slide 3, em segundos').fill('abc');
  await expect(draft.getByRole('button', { name: 'Aplicar tempos revisados' })).toBeDisabled();
  expect((await audioState(page)).positionMs).toBe(pausedAt);
  await draft.getByLabel('Tempo do slide 3, em segundos').fill('7');

  await draft.getByRole('button', { name: 'Aplicar tempos revisados' }).click();
  await expect(thumbnail(page, 0).getByTestId('thumbnail-duration')).toHaveAttribute('data-duration-ms', '4000');
  await expect(thumbnail(page, 1).getByTestId('thumbnail-duration')).toHaveAttribute('data-duration-ms', '5500');
  await expect(thumbnail(page, 2).getByTestId('thumbnail-duration')).toHaveAttribute('data-duration-ms', '7000');
  // Continua em pausa, com a faixa no início do slide atual pelos intervalos novos.
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(operator(page)).toHaveAttribute('data-audio-seeking', 'false');
  const applied = await audioState(page);
  expect(applied.paused).toBe(true);
  expect(applied.positionMs).toBe(1000);
  expect(applied.seeking).toBe(before.seeking + 1);
  await expect(page.getByTestId('checkpoint-status')).toHaveText('✓ Guardado nesta sessão');
  const [checkpoint] = await readStore<{ checkpoint: { audio: { policy: string; cues: { startMs: number; endMs: number }[] } } }>(page, 'presentationCheckpoints');
  expect(checkpoint!.checkpoint.audio).toMatchObject({ policy: 'linked', cues: [{ startMs: 1000, endMs: 5000 }, { startMs: 5000, endMs: 10_500 }, { startMs: 10_500, endMs: 17_500 }] });

  // Retomando, os slides seguem os intervalos revisados: a troca vem aos 5 s da faixa.
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 10_000 });
  const moved = (await audioState(page)).log.filter((entry) => entry.index === 1).at(-1)!;
  expect(moved.audioMs).toBeGreaterThanOrEqual(4980);
  expect(moved.audioMs).toBeLessThan(5200);
  await expectConfirmed(page, projection);

  // ── remover tempo: oferece desvincular e preserva a posição ─────────────
  await menu.getByRole('button', { name: 'Remover tempo deste slide…' }).click();
  await expect(menu.getByTestId('unlink-offer')).toContainText('continua exatamente de onde está');
  // Só abrir a oferta não muda nada.
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'linked');
  const beforeUnlink = await audioState(page);
  await menu.getByRole('button', { name: 'Desvincular a faixa e usar avanço manual' }).click();
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'independent');
  await expect(operator(page)).toHaveAttribute('data-mode', 'manual');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expect(thumbnail(page, 1).getByTestId('thumbnail-duration')).toHaveAttribute('data-duration-ms', 'null');
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await page.waitForTimeout(600);
  const unlinked = await audioState(page);
  expect(unlinked.seeking).toBe(beforeUnlink.seeking);
  expect(unlinked.paused).toBe(false);
  expect(unlinked.positionMs).toBeGreaterThan(beforeUnlink.positionMs);
  // Sem vínculo, o temporizador direto volta ao menu e o play/pause continua por causa da faixa.
  await expect(menu.getByTestId('timer')).toBeVisible();
  await expect(page.getByTestId('transport')).toBeVisible();
  // A faixa passa do antigo fim do slide e o slide não muda: o avanço agora é do operador.
  await waitAudioAt(page, 11_000);
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await page.screenshot({ path: join(EVIDENCE, 'operador-faixa-desvinculada.png') });

  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

test('AT-09 e AT-15: repertório ordenado, faixa faltante não marca pronto, pronto após conferir, fecha tudo e apresenta com áudio sem rede', async () => {
  test.setTimeout(240_000);
  let context = await profile.open();
  let page = await context.newPage();
  await createSong(page, { title: 'Em União', durations: ['3', '3'], install: true });
  const playback = wavFile('uniao-playback.wav', 12, 440);
  await importAudio(page, 'playback', playback);
  await setPolicy(page, 'playback', 'linked', '0');
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await createSong(page, { title: 'Manhã de Gratidão', durations: [null, null] });
  await page.getByRole('button', { name: '← Biblioteca' }).click();

  // ── repertório ordenado ─────────────────────────────────────────────────
  await openHiddenView(page, 'repertorios');
  await expect(page.getByTestId('setlists-empty')).toBeVisible();
  await page.getByLabel('Nome do repertório').fill('Culto de domingo');
  await page.getByLabel('Data do culto').fill('2026-10-11');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  await expect(page.getByTestId('setlist')).toBeVisible();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'notPrepared');
  const items = page.getByTestId('setlist-item');
  for (const [index, title] of ['Manhã de Gratidão', 'Em União'].entries()) {
    await page.getByLabel('Acrescentar louvor').selectOption({ label: `${title} — Culto` });
    await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
    await expect(items).toHaveCount(index + 1);
  }
  await expect(items.nth(0)).toContainText('Manhã de Gratidão');
  // Reordenar: Em União passa a abrir o culto.
  await page.getByRole('button', { name: 'Subir o louvor 2' }).click();
  await expect(items.nth(0)).toContainText('Em União');
  await expect(items.nth(0)).toContainText('com áudio');
  await expect(items.nth(1)).toContainText('Manhã de Gratidão');
  const [setlist] = await readStore<{ id: string; items: { order: number; arrangementId: string }[] }>(page, 'setlists');
  expect(setlist!.items.map((item) => item.order).sort()).toEqual([0, 1]);

  // ── AT-15: a faixa falta no dispositivo → não fica pronto ───────────────
  expect(await tamperAudioBlobs(page, 'delete')).toBe(1);
  await page.getByRole('button', { name: 'Preparar para uso offline' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('package-problems').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('package-problems').locator('li')).toHaveAttribute('data-code', 'audio-missing');
  await expect(page.getByTestId('package-problems')).toContainText('uniao-playback.wav não está neste dispositivo');
  expect((await readStore<{ ready: unknown }>(page, 'offlinePackages'))[0]!.ready).toBeNull();
  await page.screenshot({ path: join(EVIDENCE, 'repertorio-faixa-faltante.png') });

  // O problema leva ao louvor; lá o arquivo aparece como ausente e é importado de novo.
  await page.getByTestId('package-problems').getByRole('button', { name: 'Abrir o louvor' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('audio-playback').getByTestId('audio-availability')).toContainText('não está neste dispositivo');
  await importAudio(page, 'playback', playback);
  await expect(page.getByTestId('audio-playback').getByTestId('audio-availability')).toContainText('Disponível neste dispositivo');
  // Mesmo arquivo, mesmo registro: os bytes voltaram para a identidade que o arranjo já referenciava.
  expect(await readStore(page, 'assets')).toHaveLength(1);

  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByRole('link', { name: 'Culto de domingo' }).click();
  await page.getByRole('button', { name: 'Preparar para uso offline' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('package-problems')).toHaveCount(0);
  await expect(page.getByTestId('setlist-audio-bytes')).toHaveText('0,2 MB');
  const [prepared] = await readStore<{ ready: { items: { title: string; audio: { sha256: string } | null }[]; fonts: { file: string }[] } }>(page, 'offlinePackages');
  expect(prepared!.ready.items.map((item) => [item.title, item.audio !== null])).toEqual([['Em União', true], ['Manhã de Gratidão', false]]);
  expect(prepared!.ready.fonts.map((font) => font.file).sort()).toEqual(['inter-400.woff2', 'inter-700.woff2']);

  // ── mudança posterior sinaliza revisão; a cópia pronta continua utilizável ──
  await items.nth(1).getByRole('button', { name: 'Apresentar Manhã de Gratidão' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await expect(page.getByTestId('setlist')).toBeVisible();
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByRole('link', { name: 'Manhã de Gratidão' }).click();
  await page.getByLabel('Artista').fill('Coral da Vila e convidados');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByRole('link', { name: 'Culto de domingo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'stale');
  await expect(page.getByTestId('package-stale')).toContainText('"Manhã de Gratidão": o louvor foi editado.');
  await expect(page.getByTestId('package-copy')).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, 'repertorio-desatualizado.png') });
  await page.getByRole('button', { name: 'Preparar de novo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await page.screenshot({ path: join(EVIDENCE, 'repertorio-pronto.png') });
  await context.close();

  // ── AT-09: fecha tudo, desliga a rede e reabre ──────────────────────────
  await server.stop();
  expect(await isReachable()).toBe(false);
  const requestedBefore = profile.requested.length;
  context = await profile.open({ offline: true });
  page = await context.newPage();
  const response = await page.goto(`${ORIGIN}/app`);
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.getByTestId('library-item')).toHaveCount(2);

  // Editor: a faixa continua disponível e pode ser ouvida.
  await page.getByRole('link', { name: 'Em União' }).click();
  await expect(page.getByTestId('audio-playback').getByTestId('audio-availability')).toContainText('Disponível neste dispositivo');
  await page.getByTestId('audio-playback').getByRole('button', { name: '▶ Ouvir' }).click();
  await expect(page.getByTestId('audio-listen')).toBeVisible();
  expect(await page.getByTestId('audio-listen').evaluate((element: HTMLAudioElement) => new Promise((resolve) => (element.readyState >= 1 ? resolve(element.duration) : element.addEventListener('loadedmetadata', () => resolve(element.duration)))))).toBe(12);
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  // Temas e a vista offline, com o uso de áudio.
  await openHiddenView(page, 'temas');
  await expect(page.getByRole('heading', { name: 'Temas e fontes' })).toBeVisible();
  await page.getByRole('link', { name: 'Disponível offline' }).click();
  await expect(page.getByTestId('audio-usage')).toHaveAttribute('data-files', '1');
  await expect(page.getByTestId('audio-usage')).toHaveAttribute('data-unused-files', '0');

  // Repertório pronto, conferido de novo sem rede (fontes do cache, bytes do banco).
  await openHiddenView(page, 'repertorios');
  await page.getByRole('link', { name: 'Culto de domingo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Conferir de novo' }).click();
  await expect(page.getByTestId('package-progress')).toHaveCount(0);
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');

  // Apresentar pelo repertório: áudio e projeção funcionam; nada começa sozinho.
  await page.getByTestId('setlist-item').nth(0).getByRole('button', { name: 'Apresentar Em União' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'linked');
  await expect(page.getByTestId('session-warning')).toHaveCount(0);
  await watchAudio(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
  await startShow(page);
  await expectAudioPlaying(page, true);
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[0]);
  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 10_000 });
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 10_000 });
  expect(await mediaElements(projection)).toBe(0);
  await page.screenshot({ path: join(EVIDENCE, 'offline-operador-com-audio.png') });

  // Próximo louvor: ação do operador; abre preparado, sem tocar e sem iniciar.
  await page.getByTestId('next-song').click();
  await expect(page.getByRole('heading', { name: 'Manhã de Gratidão' })).toBeVisible();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('audio-none')).toBeVisible();
  await expect(page.getByTestId('next-song')).toHaveCount(0);
  expect(await mediaElements(page)).toBe(0);
  // A janela de projeção acompanha o repertório: mesma janela, ainda armada, em preto até o operador iniciar.
  await expect(projection).toHaveURL(new RegExp(`session=${await operator(page).getAttribute('data-session-id')}$`));
  await expect(output(projection)).toHaveAttribute('data-status', 'live');
  await expect(output(projection)).toHaveAttribute('data-armed', 'true');
  await expect(projection.getByTestId('projection-setup')).toHaveCount(0);
  expect(await drawn(projection)).toMatchObject({ text: '', visualMode: 'black' });
  await startShow(page);
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[0]);
  expect(await mediaElements(projection)).toBe(0);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
  // Sem rede, nenhum pedido novo a não ser os documentos e recursos servidos pelo service worker.
  expect(profile.requested.slice(requestedBefore).every((url) => url.startsWith(`${ORIGIN}/`) || /^(blob|data):/.test(url))).toBe(true);
});

test('AT-22 (mídia): arquivo inválido ou corrompido não produz falso "salvo" ou "pronto", e a recuperação é acionável', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: [null, null] });
  const good = wavFile('playback.wav', 10, 440);
  await importAudio(page, 'playback', good);
  const arrangementBefore = (await readStore<StoredArrangement>(page, 'arrangements'))[0]!;

  // ── arquivos que não são áudio aceito: nada é gravado ───────────────────
  const original = page.getByTestId('audio-import-original');
  await chooseAudio(page, 'original', { name: 'letra.wav', mimeType: 'audio/wav', buffer: Buffer.from('isto não é um arquivo de áudio') });
  await original.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(original.getByTestId('audio-import-error')).toContainText('Formato não aceito');
  // Cabeçalho de WAV seguido de lixo: passa pelo tipo, o navegador não consegue ler.
  const broken = Buffer.concat([good.buffer.subarray(0, 12), Buffer.alloc(4000, 7)]);
  await chooseAudio(page, 'original', { name: 'quebrado.wav', mimeType: 'audio/wav', buffer: broken });
  await original.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(original.getByTestId('audio-import-error')).toContainText('não conseguiu ler o áudio');
  await expect(page.getByTestId('audio-original')).toHaveAttribute('data-state', 'empty');
  expect(await readStore(page, 'assets')).toHaveLength(1);
  expect(await readStore(page, 'assetBlobs')).toHaveLength(1);
  expect((await readStore<StoredArrangement>(page, 'arrangements'))[0]).toEqual(arrangementBefore);

  // ── mídia corrompida no dispositivo ─────────────────────────────────────
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByLabel('Nome do repertório').fill('Ensaio');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  await page.getByLabel('Acrescentar louvor').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
  await expect(page.getByTestId('setlist-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Preparar para uso offline' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');

  // Os bytes guardados mudam sem mudar de tamanho: só a conferência de hash percebe.
  expect(await tamperAudioBlobs(page, 'corrupt')).toBe(1);
  // A conferência barata (presença e tamanho) ainda diz "pronto"; a completa, não.
  await page.reload();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Conferir de novo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('package-problems').locator('li')).toHaveAttribute('data-code', 'audio-corrupted');
  await expect(page.getByTestId('package-problems')).toContainText('está diferente do original');
  await page.screenshot({ path: join(EVIDENCE, 'repertorio-faixa-corrompida.png') });

  // A apresentação não começa com a faixa corrompida; oferece seguir sem áudio ou reimportar.
  await page.getByTestId('setlist-item').getByRole('button', { name: /Apresentar/ }).click();
  await expect(page.getByTestId('audio-problem')).toHaveAttribute('data-problem', 'corrupted');
  expect(await mediaElements(page)).toBe(0);
  await page.screenshot({ path: join(EVIDENCE, 'operador-faixa-corrompida.png') });
  await page.getByRole('button', { name: 'Seguir sem áudio' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'none');
  await expect(page.getByTestId('session-warning').filter({ hasText: 'A faixa de áudio não está disponível' })).toBeVisible();
  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await page.getByRole('button', { name: 'Encerrar' }).click();

  // Recuperação: reimportar o arquivo original devolve os bytes íntegros e o repertório fica pronto.
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByRole('link', { name: 'Em União' }).click();
  await importAudio(page, 'playback', good);
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await openHiddenView(page, 'repertorios');
  await page.getByRole('link', { name: 'Ensaio' }).click();
  await page.getByRole('button', { name: 'Preparar de novo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
});

test('AT-22 (espaço): escrita que estoura a quota não deixa nada salvo e o que existia continua intacto', async () => {
  // Contexto efêmero, com a quota da origem reduzida pelo protocolo de depuração antes do
  // primeiro uso: é a condição em que o Chromium a aplica nas escritas do IndexedDB. A
  // estimativa (`navigator.storage.estimate`) não reflete essa redução, então a recusa
  // antecipada fica provada só nos testes de integração; aqui a escrita falha de verdade.
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const consoleErrors: string[] = [];
  context.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  // Cabe o aplicativo (≈2 MB de cache) e uma faixa pequena; não cabe a faixa de 10 MB.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN, quotaSize: 6_000_000 });
  await createSong(page, { durations: [null, null] });
  const good = wavFile('playback.wav', 10, 440);
  await importAudio(page, 'playback', good);
  const [asset] = await readStore<StoredAsset>(page, 'assets');
  const arrangementBefore = (await readStore<StoredArrangement>(page, 'arrangements'))[0]!;
  const songsBefore = await readStore(page, 'songs');
  const original = page.getByTestId('audio-import-original');

  const big = wavFile('original-grande.wav', 630, 660);
  expect(big.buffer.length).toBeGreaterThan(10_000_000);
  await chooseAudio(page, 'original', big);
  await expect(original.getByTestId('audio-chosen-size')).toHaveText('9,6 MB');
  await original.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(original.getByTestId('audio-import-error')).toContainText('Não há espaço neste dispositivo');
  await expect(original.getByTestId('audio-import-error')).toContainText('Nada foi gravado');
  // Nenhum falso "salvo": a faixa não entrou no arranjo, nenhum byte novo ficou e o que existia está intacto.
  await expect(page.getByTestId('audio-original')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await readStore<StoredAsset>(page, 'assets')).toEqual([asset]);
  expect(await readStore<StoredBlob>(page, 'assetBlobs')).toMatchObject([{ state: 'ready', sha256: asset!.sha256, byteSize: good.buffer.length }]);
  expect((await readStore<StoredArrangement>(page, 'arrangements'))[0]).toEqual(arrangementBefore);
  expect(await readStore(page, 'songs')).toEqual(songsBefore);
  await page.getByTestId('audio-section').screenshot({ path: join(EVIDENCE, 'importacao-sem-espaco.png') });
  // A faixa que já existia continua tocável: os bytes guardados não foram tocados.
  await page.getByTestId('audio-playback').getByRole('button', { name: '▶ Ouvir' }).click();
  await expect(page.getByTestId('audio-listen')).toBeVisible();

  // Recuperação acionável: com espaço de volta, a mesma importação conclui. O navegador
  // guarda por alguns segundos o espaço que tinha calculado, então a tentativa é repetida.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN });
  await expect(async () => {
    await chooseAudio(page, 'original', big);
    await original.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('audio-original')).toHaveAttribute('data-state', 'bound', { timeout: 8000 });
  }).toPass({ timeout: 100_000, intervals: [5000] });
  expect(await readStore(page, 'assetBlobs')).toHaveLength(2);
  expect(consoleErrors.filter((message) => !/quota/i.test(message))).toEqual([]);
  await browser.close();
});

test('MP3, autoplay bloqueado e suspensão: a sessão não finge que toca e volta em pausa', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['5', '5'] });
  // MP3 sintético (quadros silenciosos): confere o segundo formato aceito.
  await importAudio(page, 'playback', mp3File('playback.mp3', 800));
  const [asset] = await readStore<StoredAsset>(page, 'assets');
  expect(asset).toMatchObject({ mimeType: 'audio/mpeg', filename: 'playback.mp3' });
  expect(asset!.durationMs).toBeGreaterThan(20_000);
  await setPolicy(page, 'playback', 'linked', '0');

  await openOperator(page);
  await watchAudio(page);
  await page.getByRole('button', { name: 'Automático', exact: true }).first().click();

  // ── autoplay bloqueado: a promessa de play() é recusada como o navegador faria ──
  await page.evaluate(() => {
    const prototype = HTMLMediaElement.prototype as HTMLMediaElement & { realPlay?: HTMLMediaElement['play'] };
    prototype.realPlay = prototype.play;
    prototype.play = () => Promise.reject(new DOMException('play() failed because the user did not interact with the document first.', 'NotAllowedError'));
  });
  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-notice', 'autoplay-blocked');
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('audio-notice')).toContainText('bloqueou o som');
  expect((await audioState(page)).paused).toBe(true);
  await page.waitForTimeout(1200);
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await page.screenshot({ path: join(EVIDENCE, 'operador-autoplay-bloqueado.png') });
  // O gesto do operador destrava.
  await page.evaluate(() => {
    const prototype = HTMLMediaElement.prototype as HTMLMediaElement & { realPlay?: HTMLMediaElement['play'] };
    if (prototype.realPlay) prototype.play = prototype.realPlay;
  });
  await page.getByRole('button', { name: '▶ Tocar agora' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expect(operator(page)).toHaveAttribute('data-notice', '');
  await expectAudioPlaying(page, true);

  // ── suspensão: o relógio de parede salta um minuto entre dois batimentos ──
  await waitAudioAt(page, 1000);
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 60_000;
  });
  await expect(operator(page)).toHaveAttribute('data-notice', 'suspension-detected', { timeout: 5000 });
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('suspension-notice')).toContainText('com a faixa parada');
  await expectAudioPlaying(page, false);
  const suspendedAt = (await audioState(page)).positionMs;
  await page.waitForTimeout(1500);
  expect((await audioState(page)).positionMs).toBe(suspendedAt);
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  // Retomar é escolha do operador e continua de onde a faixa parou.
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expectAudioPlaying(page, true);
  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 10_000 });

  // ── recuperação: recarregar o operador volta em pausa, sem autoplay, na posição guardada ──
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  const position = (await audioState(page)).positionMs;
  await expect(page.getByTestId('checkpoint-status')).toHaveText('✓ Guardado nesta sessão');
  await page.reload();
  await page.getByRole('button', { name: 'Recuperar apresentação' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(operator(page)).toHaveAttribute('data-audio-policy', 'linked');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await watchAudio(page);
  await expect.poll(async () => Math.abs((await audioState(page)).positionMs - position)).toBeLessThan(50);
  expect((await audioState(page)).paused).toBe(true);
  await page.waitForTimeout(800);
  expect((await audioState(page)).plays).toBe(0);
  expect(await mediaElements(page)).toBe(1);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
});

// Ensaio prolongado: só roda quando pedido (LV_SOAK_MINUTES), porque ocupa o equipamento por todo o período.
const soakMinutes = Number(process.env.LV_SOAK_MINUTES ?? 0);
test('ensaio offline prolongado com áudio vinculado e projeção', async () => {
  test.skip(soakMinutes <= 0, 'Defina LV_SOAK_MINUTES para rodar o ensaio prolongado.');
  test.setTimeout((soakMinutes + 5) * 60_000);
  let context = await profile.open();
  let page = await context.newPage();
  // Dois louvores com faixa vinculada, apresentados em sequência, repetidamente.
  const tracks = [
    { title: 'Em União', file: wavFile('uniao.wav', 62, 440) },
    { title: 'Manhã de Gratidão', file: wavFile('manha.wav', 62, 523) },
  ];
  for (const [index, track] of tracks.entries()) {
    await createSong(page, { title: track.title, durations: ['15', '15', '15', '15'], install: index === 0 });
    await importAudio(page, 'playback', track.file);
    await setPolicy(page, 'playback', 'linked', '1');
    await page.getByRole('button', { name: '← Biblioteca' }).click();
  }
  await openHiddenView(page, 'repertorios');
  await page.getByLabel('Nome do repertório').fill('Ensaio prolongado');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  for (const [index, track] of tracks.entries()) {
    await page.getByLabel('Acrescentar louvor').selectOption({ label: `${track.title} — Culto` });
    await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
    await expect(page.getByTestId('setlist-item')).toHaveCount(index + 1);
  }
  await page.getByRole('button', { name: 'Preparar para uso offline' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  await context.close();
  await server.stop();

  context = await profile.open({ offline: true });
  page = await context.newPage();
  await page.goto(`${ORIGIN}/app?view=repertorios`);
  await page.getByRole('link', { name: 'Ensaio prolongado' }).click();
  // Memória do operador lida pelo protocolo de depuração (a leitura da página é arredondada pelo navegador).
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const memory = async () => ((await cdp.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6;
  const stored = () => page.evaluate(async () => ((await navigator.storage.estimate()).usage ?? 0) / 1e6);
  const startedAt = Date.now();
  const heapStart = await memory();
  const storedStart = await stored();
  let heapPeak = heapStart;
  const deviations: number[] = [];
  let songs = 0;
  let projection: Page | null = null;

  await page.getByTestId('setlist-item').nth(0).getByRole('button', { name: /Apresentar/ }).click();
  while (Date.now() - startedAt < soakMinutes * 60_000) {
    await expect(operator(page)).toHaveAttribute('data-status', 'ready');
    await expect(operator(page)).toHaveAttribute('data-audio-policy', 'linked');
    await watchAudio(page);
    // No "próximo louvor" a janela acompanha sozinha; depois de encerrar, é aberta de novo.
    const sessionId = await operator(page).getAttribute('data-session-id');
    if (projection && !projection.url().endsWith(`session=${sessionId}`)) {
      await projection.close();
      projection = null;
    }
    projection ??= await openProjection(context, page);
    await expect(operator(page)).toHaveAttribute('data-projection-armed', 'true');
    if ((await operator(page).getAttribute('data-mode')) !== 'automatic') await page.getByRole('button', { name: 'Automático', exact: true }).first().click();
    await startShow(page);
    await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 90_000 });
    const run = await audioState(page);
    for (const [index, start] of [[1, 16_000], [2, 31_000], [3, 46_000]] as const) {
      const entry = run.log.find((item) => item.index === index);
      expect(entry, `troca para o slide ${index + 1}`).toBeTruthy();
      deviations.push(entry!.audioMs - start);
    }
    expect(await mediaElements(page)).toBe(1);
    expect(await mediaElements(projection)).toBe(0);
    await expectConfirmed(page, projection);
    heapPeak = Math.max(heapPeak, await memory());
    songs += 1;
    // Próximo louvor; no último, volta ao repertório e recomeça do primeiro.
    if ((await page.getByTestId('next-song').count()) > 0) {
      await page.getByTestId('next-song').click();
    } else {
      await page.getByRole('button', { name: 'Encerrar' }).click();
      await page.getByTestId('setlist-item').nth(0).getByRole('button', { name: /Apresentar/ }).click();
    }
    await expect(page.locator('audio[data-testid="session-audio"]')).toHaveCount(1);
  }

  // Integridade ao final: a conferência completa do repertório continua passando, sem rede.
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await page.getByRole('button', { name: 'Conferir de novo' }).click();
  await expect(page.getByTestId('package-state')).toHaveAttribute('data-state', 'ready');
  const sorted = [...deviations].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  console.log(
    `ENSAIO minutos=${((Date.now() - startedAt) / 60_000).toFixed(1)} louvores=${songs} trocas=${deviations.length} desvio_p95_ms=${Math.round(p95 ?? NaN)} desvio_max_ms=${Math.round(sorted.at(-1) ?? NaN)} desvio_min_ms=${Math.round(sorted[0] ?? NaN)} heap_inicio_mb=${heapStart.toFixed(1)} heap_pico_mb=${heapPeak.toFixed(1)} heap_fim_mb=${(await memory()).toFixed(1)} armazenado_inicio_mb=${storedStart.toFixed(1)} armazenado_fim_mb=${(await stored()).toFixed(1)} erros_console=${profile.consoleErrors.length} pedidos_externos=${profile.externalRequests().length}`,
  );
  expect(p95).toBeLessThanOrEqual(200);
  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
  await context.close();
});
