import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BrowserProfile, isReachable, ProductionServer } from './helpers';
import {
  channelLog,
  createSong,
  drawn,
  expectConfirmed,
  fontInUse,
  mediaElements,
  openOperator,
  openProjection,
  operator,
  output,
  percentile,
  readStore,
  recordChannel,
  recordTransitions,
  SLIDE_TEXTS,
  slideSettled,
  startShow,
  transitions,
  wallClock,
} from './presentation.helpers';

type Manifest = { fonts: { fontId: string; family: string; faces: { weight: number; file: string }[] }[] };
const manifest: Manifest = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'fonts', 'v1', 'manifest.json'), 'utf8'));
const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '06-evidencias');
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
/** Temas de fábrica do planejamento/07: fundo, letra e fonte inicial. */
const THEMES = [
  ['grafite', '#111827', '#F9FAFB', 'Inter'],
  ['azul-noturno', '#0B1730', '#DBEAFE', 'Roboto'],
  ['violeta', '#1B1033', '#EDE9FE', 'Montserrat'],
  ['verde-profundo', '#0B2119', '#D1FAE5', 'Lato'],
  ['vinho', '#2A0E18', '#FFE4E6', 'Open Sans'],
  ['ambar', '#211809', '#FDE68A', 'Source Sans 3'],
  ['petroleo', '#08242A', '#CCFBF1', 'Noto Sans'],
  ['preto-acessivel', '#000000', '#FFFFFF', 'Atkinson Hyperlegible'],
] as const;

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

test('AT-04, AT-08, AT-16: manual, janela pública limpa, controlador único, reconexão e saída visual', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  // O primeiro slide tem tempo curto de propósito: no manual ele não pode avançar sozinho.
  const NOTES = 'Entrar só depois do ofertório. Tom original: Ré.';
  await createSong(page, { durations: ['0,5', null, null, null], notes: NOTES });
  await openOperator(page);
  await expect(page.getByTestId('private-notes')).toHaveText(NOTES);
  await expect(operator(page)).toHaveAttribute('data-mode', 'manual');
  await expect(operator(page)).toHaveAttribute('data-projection', 'none');

  // ── janela pública: ajuda antes de armar, limpa depois ──────────────────
  const projection = await openProjection(context, page, { arm: false });
  await expect(projection).toHaveURL(new RegExp(`/projecao\\?session=${await operator(page).getAttribute('data-session-id')}$`));
  await expect(projection.getByTestId('projection-setup')).toBeVisible();
  await expect(projection.getByTestId('setup-connection')).toContainText('Conectada ao painel do operador — Em União');
  await expect(projection.locator('[data-slide-frame]')).toHaveCount(0);
  await expect(page.getByTestId('projection-status')).toContainText('falta armar a saída');
  await recordChannel(projection);
  await projection.getByRole('button', { name: 'Armar saída' }).click();
  await expect(projection.getByTestId('projection-setup')).toHaveCount(0);
  await expect(page.getByTestId('projection-status')).toHaveText('● Projeção conectada.');

  // Pronta: o operador vê o primeiro slide, o público vê preto.
  await expect(page.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[0]!);
  expect(await drawn(projection)).toMatchObject({ text: '', background: 'rgb(0, 0, 0)', visualMode: 'black' });

  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: SLIDE_TEXTS[0], visible: true, background: 'rgb(17, 24, 39)', color: 'rgb(249, 250, 251)', family: 'Inter', weight: '700' });

  // Saída limpa por padrão: só o slide. Nenhum botão, relógio, nota ou mídia.
  await slideSettled(projection);
  expect(await projection.evaluate(() => document.body.innerText.trim())).toBe(SLIDE_TEXTS[0]);
  await expect(projection.locator('button, input, a, [data-testid="countdown"], [data-testid="timer-static"], [data-corner-button]')).toHaveCount(0);
  await expect(output(projection)).toHaveAttribute('data-controls', 'false');
  expect(await mediaElements(projection)).toBe(0);
  expect(await mediaElements(page)).toBe(0);

  // ── AT-04: nenhum avanço sem comando, mesmo com 0,5 s no slide ──────────
  await expect(page.getByTestId('timer-indicator')).toHaveAttribute('data-duration-ms', '500');
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await expect(page.getByTestId('transport')).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await expect(output(projection)).toHaveAttribute('data-occurrence-id', (await operator(page).getAttribute('data-occurrence-id'))!);

  // Botão, teclado e miniatura; a saída confirma cada troca.
  const confirmTimes: number[] = [];
  const confirmed = async () => {
    await expectConfirmed(page, projection);
    confirmTimes.push(Number(await operator(page).getAttribute('data-last-confirm-ms')));
  };
  await page.getByTestId('advance').click();
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await confirmed();
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  // Slide sem tempo: sem indicador nem contagem.
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await page.locator('body').press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  await confirmed();
  await page.locator('body').press('PageUp');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await confirmed();
  await page.getByTestId('thumbnail').nth(3).click();
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  await confirmed();
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[3]);
  // Próximo no último não sai da sequência.
  await page.locator('body').press('ArrowRight');
  await expect(page.getByTestId('operator-message')).toHaveText('Já está no limite.');
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  await page.locator('body').press('Home');
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await confirmed();
  // Espaço não executa transporte em manual (com o foco fora de qualquer botão).
  await page.getByRole('heading', { name: 'Em União' }).click();
  await page.locator('body').press('Space');
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  for (let step = 0; step < 12; step += 1) {
    await page.locator('body').press(step % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
    await confirmed();
  }
  test.info().annotations.push({ type: 'troca manual confirmada (ms)', description: `n=${confirmTimes.length} p95=${percentile(confirmTimes, 95)} max=${Math.max(...confirmTimes)}` });
  expect(percentile(confirmTimes, 95)).toBeLessThanOrEqual(150);

  // ── AT-08: alternar o foco para a janela pública ────────────────────────
  await projection.bringToFront();
  await projection.locator('body').press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await page.bringToFront();

  // Segundo painel de operador no mesmo dispositivo é recusado e não toca na sessão.
  const sequenceBefore = await operator(page).getAttribute('data-sequence');
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByTestId('controller-blocked')).toBeVisible();
  await expect(second.getByTestId('operator')).toHaveCount(0);
  await second.close();
  await expect(operator(page)).toHaveAttribute('data-sequence', sequenceBefore!);

  // ── AT-16: tela preta, ocultar letra e congelar ─────────────────────────
  await page.locator('body').press('b');
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: '', background: 'rgb(0, 0, 0)', visualMode: 'black' });
  await expect(page.getByTestId('public-summary')).toHaveText('Tela preta');
  // O operador continua vendo o slide atual.
  await expect(page.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[1]!);
  await page.getByRole('button', { name: 'Ocultar letra' }).first().click();
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: '', background: 'rgb(17, 24, 39)', visualMode: 'lyricsHidden' });
  await page.locator('body').press('l');
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: SLIDE_TEXTS[1], visualMode: 'normal' });

  await page.locator('body').press('c');
  await expect(operator(page)).toHaveAttribute('data-frozen', 'true');
  await page.locator('body').press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await expect(page.getByTestId('public-summary')).toHaveText('Letra visível · congelada · diferente do slide atual');
  await expect(page.getByTestId('public-preview').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[1]!);
  await page.locator('body').press('c');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[2]);
  // Nada disso pausou a sessão.
  await expect(operator(page)).toHaveAttribute('data-status', 'running');

  // Notas privadas e biblioteca nunca passaram pelo canal da projeção.
  const messages = await channelLog(projection);
  const PROTOCOL = ['PROJECTION_HELLO', 'SESSION_SNAPSHOT', 'VISUAL_STATE', 'OPERATOR_COMMAND', 'STATE_ACK', 'HEARTBEAT', 'SESSION_ENDED'];
  for (const message of messages) expect(PROTOCOL).toContain(message.type);
  expect(messages.filter((message) => message.type === 'VISUAL_STATE').length).toBeGreaterThan(20);
  expect(JSON.stringify(messages)).not.toContain('ofertório');
  expect(JSON.stringify(messages)).not.toContain('rawLyrics');
  expect(await projection.evaluate(() => document.body.innerText)).not.toContain('ofertório');

  // ── reconexão: a janela pública é fechada e reaberta ────────────────────
  await projection.close();
  await expect(page.getByTestId('projection-status')).toHaveText('⚠ A janela de projeção não está respondendo. Reabrir projeção.', { timeout: 8000 });
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  const reopened = await openProjection(context, page);
  await expect(page.getByTestId('projection-status')).toHaveText('● Projeção conectada.');
  await expectConfirmed(page, reopened);
  expect((await drawn(reopened))!.text).toBe(SLIDE_TEXTS[2]);

  // ── o operador recarrega: a saída mantém a última imagem e não comanda ──
  await page.locator('body').press('ArrowRight');
  await expectConfirmed(page, reopened);
  await expect(page.getByTestId('checkpoint-status')).toHaveAttribute('data-state', 'saved');
  const generation = Number(await output(reopened).getAttribute('data-generation'));
  await page.reload();
  await expect(page.getByTestId('recover-prompt')).toBeVisible();
  await expect(output(reopened)).toHaveAttribute('data-controller-lost', 'true', { timeout: 8000 });
  expect((await drawn(reopened))!.text).toBe(SLIDE_TEXTS[3]);
  await reopened.locator('body').press('ArrowLeft');
  await page.getByRole('button', { name: 'Recuperar apresentação' }).click();
  // ── AT-17: volta em pausa, no mesmo slide, e a saída reconhece o novo controlador ──
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  await expect(output(reopened)).toHaveAttribute('data-controller-lost', 'false');
  await expectConfirmed(page, reopened);
  expect(Number(await output(reopened).getAttribute('data-generation'))).toBeGreaterThan(generation);
  expect((await drawn(reopened))!.text).toBe(SLIDE_TEXTS[3]);

  // Encerrar libera a saída, que volta a preto.
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(output(reopened)).toHaveAttribute('data-status', 'ended');
  expect(await drawn(reopened)).toBeNull();
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

/** Tolerância da meta de desvio de transição automática (planejamento/15). */
const DRIFT_MS = 200;

test('AT-05: automático com 8, 12 e 10 segundos em relógio real, com pausa e retomada', async () => {
  test.setTimeout(180_000);
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['8', '12', '10'] });
  await openOperator(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático' }).first().click();
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  await recordTransitions(projection);
  const ids = await page.getByTestId('thumbnail').evaluateAll((items) => items.map((item) => item.getAttribute('data-occurrence-id')!));

  await startShow(page);
  const startedAt = await wallClock(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  // Indicador, contagem e play/pause existem porque o slide atual tem tempo no automático.
  await expect(page.getByTestId('timer-indicator')).toHaveAttribute('data-duration-ms', '8000');
  await expect(page.getByTestId('transport')).toHaveText('❚❚ Pausar');
  const first = Number(await page.getByTestId('countdown').first().getAttribute('data-remaining-ms'));
  expect(first).toBeGreaterThan(7000);
  expect(first).toBeLessThanOrEqual(8000);
  // A janela pública continua sem relógio.
  await expect(projection.locator('[data-testid="countdown"], [data-testid="timer-static"], button')).toHaveCount(0);

  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 12_000 });
  // Pausa aos ~4 s do slide de 12 s, por 3 s: nada avança e a contagem para.
  await page.waitForTimeout(4000);
  await page.locator('body').press('Space');
  const pausedAt = await wallClock(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await page.getByTestId('transport').click();
  const resumedAt = await wallClock(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');

  await expect(operator(page)).toHaveAttribute('data-index', '2', { timeout: 15_000 });
  await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 15_000 });
  const finishedAt = await wallClock(page);
  await expectConfirmed(page, projection);
  // Terminar mantém o último slide; nada mais avança.
  await page.waitForTimeout(1500);
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[2]);

  // A primeira entrada é o início: o mesmo slide deixa de estar coberto de preto.
  const seen = await transitions(projection);
  expect(seen.map((item) => [item.id, item.mode])).toEqual([
    [ids[0], 'normal'],
    [ids[1], 'normal'],
    [ids[2], 'normal'],
  ]);
  const pause = resumedAt - pausedAt;
  const measured = {
    'slide 1 (8 s)': seen[1]!.at - seen[0]!.at,
    'slide 2 (12 s + pausa)': seen[2]!.at - seen[1]!.at - pause,
    'slide 3 (10 s)': finishedAt - seen[2]!.at,
  };
  test.info().annotations.push({ type: 'duração medida na janela pública (ms)', description: JSON.stringify({ ...measured, pausa: Math.round(pause), iniciar: Math.round(seen[0]!.at - startedAt) }) });
  expect(Math.abs(measured['slide 1 (8 s)'] - 8000)).toBeLessThanOrEqual(DRIFT_MS);
  expect(Math.abs(measured['slide 2 (12 s + pausa)'] - 12_000)).toBeLessThanOrEqual(DRIFT_MS);
  // O fim é observado pelo teste por consulta, com folga maior que a de uma troca desenhada.
  expect(Math.abs(measured['slide 3 (10 s)'] - 10_000)).toBeLessThanOrEqual(DRIFT_MS + 300);
  expect(await mediaElements(projection)).toBe(0);
  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

test('AT-06 e AT-27: saltos no automático, slide sem tempo espera comando e ajustes visuais não reiniciam o relógio', async () => {
  test.setTimeout(180_000);
  const context = await profile.open();
  const page = await context.newPage();
  // A: 4 s · B: sem tempo · C: 6 s · D: 3 s
  await createSong(page, { durations: ['4', null, '6', '3'] });
  await openOperator(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático' }).first().click();
  await recordTransitions(projection);
  const ids = await page.getByTestId('thumbnail').evaluateAll((items) => items.map((item) => item.getAttribute('data-occurrence-id')!));
  const [a, b, c, d] = ids as [string, string, string, string];
  const remaining = async () => Number(await page.getByTestId('countdown').first().getAttribute('data-remaining-ms'));
  const lastOf = async (id: string) => (await transitions(projection)).filter((item) => item.id === id).at(-1)!.at;

  await startShow(page);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');

  // ── AT-06: no A há ~2 s, o operador seleciona C ─────────────────────────
  await page.waitForTimeout(2000);
  await page.getByTestId('thumbnail').nth(2).click();
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  // C começa do zero, com os 6 s inteiros.
  expect(await remaining()).toBeGreaterThan(5500);

  // Ajustes visuais durante C: nada disso é um salto nem reinicia o intervalo.
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await page.locator('[data-theme="violeta"]').click();
  await page.locator('[data-font="lato"]').click();
  await page.getByRole('button', { name: '90°' }).click();
  await page.getByRole('button', { name: 'Esquerda' }).click();
  await expect(operator(page)).toHaveAttribute('data-overrides-revision', '5');
  await expect(operator(page)).toHaveAttribute('data-rotation', '90');
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ background: 'rgb(27, 16, 51)', color: 'rgb(237, 233, 254)', family: 'Lato', rotation: '90', align: 'left', inside: true });
  expect(await remaining()).toBeLessThan(5000);
  await expect(operator(page)).toHaveAttribute('data-index', '2');

  // C → D exatamente 6 s depois de C aparecer, apesar dos ajustes.
  await expect(operator(page)).toHaveAttribute('data-index', '3', { timeout: 8000 });
  expect(Math.abs((await lastOf(d)) - (await lastOf(c)) - 6000)).toBeLessThanOrEqual(DRIFT_MS);

  // Durante D, voltar para A: A começa um novo intervalo de 4 s e o modo continua automático.
  await page.waitForTimeout(800);
  await page.getByTestId('thumbnail').nth(0).click();
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  expect(await remaining()).toBeGreaterThan(3500);
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');

  // ── AT-27: 4 s → sem tempo → 6 s ────────────────────────────────────────
  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 6000 });
  expect(Math.abs((await lastOf(b)) - (await lastOf(a)) - 4000)).toBeLessThanOrEqual(DRIFT_MS);
  await expect(operator(page)).toHaveAttribute('data-awaiting', 'true');
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  // Indicador, contagem e play/pause somem; não há duração inventada.
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await expect(page.getByTestId('transport')).toHaveCount(0);
  await expect(page.getByTestId('timing').getByTestId('awaiting-advance')).toBeVisible();
  await page.getByRole('heading', { name: 'Em União' }).click();
  await page.locator('body').press('Space');
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await page.waitForTimeout(5000);
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);

  // O próximo temporizado retoma o automático em execução, com o intervalo inteiro.
  await page.locator('body').press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '2');
  await expect(operator(page)).toHaveAttribute('data-awaiting', 'false');
  expect(await remaining()).toBeGreaterThan(5500);

  // ── pausado: o salto escolhe o destino, zera o tempo e continua pausado ──
  await page.waitForTimeout(1500);
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await page.getByTestId('thumbnail').nth(3).click();
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[3]);
  await page.waitForTimeout(4000);
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');

  // ── tempo pelo menu: remover para de avançar; aplicar reinicia a contagem ──
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  const menu = page.getByTestId('live-menu');
  await menu.getByRole('button', { name: 'Remover tempo do slide atual' }).click();
  await expect(operator(page)).toHaveAttribute('data-awaiting', 'true');
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await page.waitForTimeout(3500);
  await expect(operator(page)).toHaveAttribute('data-status', 'running');
  await expect(operator(page)).toHaveAttribute('data-index', '3');
  // O menu continua oferecendo adicionar tempo.
  await menu.getByRole('button', { name: 'Adicionar tempo ao slide atual' }).click();
  const field = menu.getByLabel('Tempo do slide atual, em segundos');
  await expect(field).toHaveValue('8');
  await field.fill('2');
  await field.press('Enter');
  await expect(page.getByTestId('timer-indicator')).toHaveAttribute('data-duration-ms', '2000');
  await expect(operator(page)).toHaveAttribute('data-status', 'finished', { timeout: 4000 });
  await expect(operator(page)).toHaveAttribute('data-index', '3');

  await context.close();
  expect(profile.consoleErrors).toEqual([]);
});

const THEME_BACKGROUNDS = ['#111827', '#0B1730', '#1B1033', '#0B2119', '#2A0E18', '#211809', '#08242A', '#000000'];

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contraste de uma cor com alfa desenhada sobre um fundo sólido. */
function contrastOver(rgba: string, backgroundHex: string): number {
  const [r, g, b, alpha = 1] = rgba.match(/[\d.]+/g)!.map(Number) as [number, number, number, number?];
  const background = [1, 3, 5].map((start) => parseInt(backgroundHex.slice(start, start + 2), 16)) as [number, number, number];
  const blended = [r, g, b].map((value, index) => value * alpha + background[index]! * (1 - alpha)) as [number, number, number];
  const [light, dark] = [luminance(blended), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

test('AT-28, AT-29, AT-32: cantos, ajustes ao vivo, giro, controles na projeção e rascunho de texto com saída congelada', async () => {
  test.setTimeout(180_000);
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: [null, '8', null] });
  await openOperator(page);
  const projection = await openProjection(context, page);
  await startShow(page);
  await expectConfirmed(page, projection);

  // ── AT-28: quatro cantos no modo interativo ─────────────────────────────
  await page.getByRole('button', { name: 'Modo interativo' }).click();
  const stage = page.getByTestId('interactive-stage');
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  const corners = () =>
    stage.locator('[data-corner]').evaluateAll((items) =>
      Object.fromEntries(items.map((item) => [item.getAttribute('data-corner'), [...item.querySelectorAll('[data-corner-button]')].map((button) => button.getAttribute('data-testid'))])),
    );
  // Manual, slide sem tempo: sem indicador de tempo e sem play/pause.
  expect(await corners()).toEqual({
    'top-left': ['corner-menu'],
    'top-right': ['corner-rotate', 'corner-fullscreen'],
    'bottom-left': ['corner-previous'],
    'bottom-right': ['corner-smaller', 'corner-larger', 'corner-next'],
  });
  const viewport = page.viewportSize()!;
  const placement = await stage.locator('[data-corner]').evaluateAll((items) =>
    Object.fromEntries(items.map((item) => [item.getAttribute('data-corner'), (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(item.getBoundingClientRect())])),
  );
  expect(placement['top-left']).toMatchObject({ left: 16, top: 16 });
  expect(placement['top-right']).toMatchObject({ right: viewport.width - 16, top: 16 });
  expect(placement['bottom-left']).toMatchObject({ left: 16, bottom: viewport.height - 16 });
  expect(placement['bottom-right']).toMatchObject({ right: viewport.width - 16, bottom: viewport.height - 16 });

  // Repouso: fundo transparente, borda de 1 px e ícone cinza claro; nada de opacidade no botão inteiro.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.waitForTimeout(300);
  const look = (testId: string) =>
    page.getByTestId(testId).evaluate((button) => {
      const style = getComputedStyle(button);
      const box = button.getBoundingClientRect();
      const icon = button.querySelector('svg')!.getBoundingClientRect();
      return { background: style.backgroundColor, border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`, color: style.color, opacity: style.opacity, transform: style.transform, width: box.width, height: box.height, icon: icon.width, left: box.left, top: box.top };
    });
  for (const testId of ['corner-menu', 'corner-rotate', 'corner-fullscreen', 'corner-previous', 'corner-smaller', 'corner-larger', 'corner-next']) {
    const rest = await look(testId);
    expect(rest, testId).toMatchObject({ background: 'rgba(0, 0, 0, 0)', border: '1px solid rgba(209, 213, 219, 0.35)', color: 'rgba(209, 213, 219, 0.75)', opacity: '1', transform: 'none' });
    expect(rest.width, testId).toBeGreaterThanOrEqual(44);
    expect(rest.height, testId).toBeGreaterThanOrEqual(44);
    expect(rest.icon, testId).toBeGreaterThanOrEqual(20);
    expect(rest.icon, testId).toBeLessThanOrEqual(24);
    await expect(page.getByTestId(testId)).toHaveAccessibleName(/.+/);
  }
  // O ícone em repouso tem pelo menos 3:1 sobre o fundo dos oito temas.
  const iconColor = (await look('corner-next')).color;
  for (const background of THEME_BACKGROUNDS) expect(contrastOver(iconColor, background), background).toBeGreaterThanOrEqual(3);
  // Hover deixa borda e ícone mais nítidos.
  await page.getByTestId('corner-next').hover();
  await page.waitForTimeout(300);
  expect(await look('corner-next')).toMatchObject({ border: '1px solid rgba(209, 213, 219, 0.9)', color: 'rgb(209, 213, 219)' });

  // Três segundos sem interação escondem; o ponteiro traz de volta.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await expect(stage).toHaveAttribute('data-controls-visible', 'false', { timeout: 4500 });
  await expect(page.getByTestId('corner-next')).toBeHidden();
  await page.mouse.move(viewport.width / 2 + 40, viewport.height / 2);
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  // Teclado revela e o foco em um controle impede a auto-ocultação.
  await expect(stage).toHaveAttribute('data-controls-visible', 'false', { timeout: 4500 });
  await page.keyboard.press('Tab');
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  await expect(page.getByTestId('corner-menu')).toBeFocused();
  expect((await page.getByTestId('corner-menu').evaluate((button) => getComputedStyle(button).outlineStyle))).toBe('solid');
  await page.waitForTimeout(4000);
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  // Menu aberto também mantém os controles.
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('live-menu');
  await expect(menu).toBeVisible();
  await page.mouse.move(viewport.width - 200, viewport.height / 2);
  await page.waitForTimeout(4000);
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');

  // O menu sempre permite adicionar tempo; o indicador volta, e o automático traz o play/pause.
  await menu.getByRole('button', { name: 'Adicionar tempo ao slide atual' }).click();
  await menu.getByLabel('Tempo do slide atual, em segundos').press('Enter');
  await expect(page.getByTestId('corner-timer')).toBeVisible();
  await expect(page.getByTestId('corner-timer').getByTestId('timer-static')).toHaveText('8 s');
  await expect(page.getByTestId('corner-transport')).toHaveCount(0);
  await menu.getByRole('button', { name: 'Automático' }).click();
  await expect(page.getByTestId('corner-transport')).toHaveAccessibleName('Pausar');
  await expect(page.getByTestId('corner-timer').getByTestId('countdown')).toBeVisible();
  await page.getByTestId('corner-transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('corner-transport')).toHaveAccessibleName('Retomar');
  await page.getByTestId('corner-transport').click();
  await menu.getByRole('button', { name: 'Manual' }).click();
  await expect(page.getByTestId('corner-transport')).toHaveCount(0);
  await menu.getByRole('button', { name: 'Remover tempo do slide atual' }).click();
  await expect(page.getByTestId('corner-timer')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.screenshot({ path: join(EVIDENCE, 'operador-modo-interativo.png') });

  // ── AT-29: A−/A+, tema, fonte e giro refletem na saída ──────────────────
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await expectConfirmed(page, projection);
  const base = (await drawn(projection))!;
  expect(base.fontSizeRatio).toBeCloseTo(96 / 1920, 4);
  await page.getByTestId('corner-larger').click();
  await page.getByTestId('corner-larger').click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.fontSizeRatio).toBeCloseTo(104 / 1920, 4);
  await page.getByTestId('corner-smaller').click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.fontSizeRatio).toBeCloseTo(100 / 1920, 4);

  await page.getByTestId('corner-menu').click();
  await menu.locator('[data-theme="ambar"]').click();
  await menu.getByRole('group', { name: 'Onde aplicar: fonte' }).getByLabel('Este slide').check();
  await menu.locator('[data-font="montserrat"]').click();
  await expectConfirmed(page, projection);
  // Fundo e letra mudam juntos; a fonte é a escolhida.
  expect(await drawn(projection)).toMatchObject({ background: 'rgb(33, 24, 9)', color: 'rgb(253, 230, 138)', family: 'Montserrat', text: SLIDE_TEXTS[0] });
  await page.keyboard.press('Escape');

  // Escopo: tamanho e fonte ficaram só neste slide; o tema vale para o louvor.
  await page.getByTestId('corner-next').click();
  await expectConfirmed(page, projection);
  const second = (await drawn(projection))!;
  expect(second).toMatchObject({ background: 'rgb(33, 24, 9)', color: 'rgb(253, 230, 138)', family: 'Source Sans 3', text: SLIDE_TEXTS[1] });
  expect(second.fontSizeRatio).toBeCloseTo(96 / 1920, 4);
  await page.getByTestId('corner-previous').click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.family).toBe('Montserrat');

  // Giro: paisagem e retrato, composição inteira dentro da saída e controles acompanhantes.
  const before = await look('corner-next');
  for (const rotation of ['90', '0']) {
    await page.getByTestId('corner-rotate').click();
    await expect(operator(page)).toHaveAttribute('data-rotation', rotation);
    await expectConfirmed(page, projection);
    const turned = (await drawn(projection))!;
    expect(turned, rotation).toMatchObject({ rotation, inside: true, clipped: false, text: SLIDE_TEXTS[0], background: 'rgb(33, 24, 9)' });
    if (rotation === '90') await projection.screenshot({ path: join(EVIDENCE, 'janela-publica-girada-90.png') });
    // De lado, a caixa da composição fica em pé e cabe na altura da janela.
    const sideways = rotation === '90';
    expect(turned.box.width / turned.box.height, rotation).toBeCloseTo(sideways ? 9 / 16 : 16 / 9, 2);
    expect(turned.fontSizeRatio, rotation).toBeCloseTo(100 / 1920, 4);
    // O palco do operador gira igual e os botões acompanham a orientação.
    expect(await drawn(page, '[data-testid="interactive-stage"]')).toMatchObject({ rotation, inside: true });
    const button = await look('corner-next');
    if (rotation === '90') expect(button).not.toMatchObject({ transform: 'none', left: before.left, top: before.top });
    else expect(button).toMatchObject({ transform: 'none', left: before.left, top: before.top, width: before.width });
  }

  // ── AT-32: controles habilitados na própria janela pública ──────────────
  await expect(output(projection)).toHaveAttribute('data-controls', 'false');
  await projection.bringToFront();
  await projection.locator('body').press('m');
  await projection.getByLabel('Mostrar controles nesta tela').check();
  await projection.getByRole('button', { name: 'Fechar preparação' }).click();
  await expect(output(projection)).toHaveAttribute('data-controls', 'true');
  const publicStage = projection.getByTestId('interactive-stage');
  await projection.mouse.move(300, 300);
  await expect(publicStage).toHaveAttribute('data-controls-visible', 'true');
  expect(await publicStage.locator('[data-corner-button]').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')))).toEqual([
    'corner-menu',
    'corner-rotate',
    'corner-fullscreen',
    'corner-previous',
    'corner-smaller',
    'corner-larger',
    'corner-next',
  ]);
  await projection.screenshot({ path: join(EVIDENCE, 'janela-publica-com-controles.png') });
  // Um clique na saída = um comando no controlador único.
  const sequence = Number(await operator(page).getAttribute('data-sequence'));
  await projection.getByTestId('corner-next').click();
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expectConfirmed(page, projection);
  expect(Number(await operator(page).getAttribute('data-sequence'))).toBe(sequence + 1);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  // Slide com tempo: a saída mostra a duração fixa; a contagem existe só no operador.
  await expect(projection.getByTestId('corner-timer').getByTestId('timer-static')).toHaveText('8 s');
  await projection.getByTestId('corner-menu').click();
  const publicMenu = projection.getByTestId('live-menu');
  await publicMenu.getByRole('button', { name: 'Automático' }).click();
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  await expect(projection.getByTestId('corner-transport')).toHaveAccessibleName('Pausar');
  await expect(page.getByTestId('corner-timer').getByTestId('countdown')).toBeVisible();
  await expect(projection.getByTestId('countdown')).toHaveCount(0);
  await projection.getByTestId('corner-transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await publicMenu.getByRole('button', { name: 'Manual' }).click();
  await publicMenu.getByRole('button', { name: 'Aumentar a letra' }).click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.fontSizeRatio).toBeCloseTo(100 / 1920, 4);
  // Texto ao vivo e salvar no arranjo ficam só na área do operador.
  await expect(publicMenu.getByText('Editar texto atual')).toHaveCount(0);
  await expect(publicMenu.getByText('Guardar ajustes')).toHaveCount(0);
  expect(await mediaElements(projection)).toBe(0);
  expect(await mediaElements(page)).toBe(0);
  await publicMenu.getByRole('button', { name: 'Ocultar controles nesta tela' }).click();
  await expect(output(projection)).toHaveAttribute('data-controls', 'false');
  await expect(projection.locator('button')).toHaveCount(0);

  // ── rascunho de texto com a saída congelada ─────────────────────────────
  await page.bringToFront();
  await page.getByRole('button', { name: 'Painel completo' }).click();
  await page.getByRole('heading', { name: 'Em União' }).click();
  await page.locator('body').press('c');
  await expect(operator(page)).toHaveAttribute('data-frozen', 'true');
  await page.getByRole('button', { name: 'Abrir rascunho do texto' }).click();
  const revised = 'Hoje cantamos em comunhão\nCom alegria e gratidão';
  await page.getByLabel('Rascunho (só você vê)').fill(revised);
  // Teclas digitadas no rascunho não são atalhos.
  await page.getByLabel('Rascunho (só você vê)').press('End');
  await expect(operator(page)).toHaveAttribute('data-visual-mode', 'normal');
  await expect(page.getByTestId('draft-preview').locator('[data-slide-text]')).toHaveText(revised);
  // Antes de aplicar, nada muda: nem o slide atual, nem a saída.
  const revisionBefore = await operator(page).getAttribute('data-overrides-revision');
  await expect(page.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[1]!);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await page.getByRole('button', { name: 'Aplicar ao vivo' }).click();
  await expect(page.getByTestId('current-slide').locator('[data-slide-text]')).toHaveText(revised);
  expect(Number(await operator(page).getAttribute('data-overrides-revision'))).toBe(Number(revisionBefore) + 1);
  await expectConfirmed(page, projection);
  await page.screenshot({ path: join(EVIDENCE, 'operador-painel-saida-congelada.png'), fullPage: true });
  // Aplicado, mas congelada: o público continua com a imagem antiga até liberar.
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await expect(page.getByTestId('public-summary')).toContainText('congelada · diferente do slide atual');
  await page.getByRole('button', { name: 'Liberar saída' }).first().click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(revised);

  // Desfazer recupera o texto anterior; a sessão continua pausada como estava.
  await page.getByRole('button', { name: '↶ Desfazer último ajuste' }).click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.text).toBe(SLIDE_TEXTS[1]);
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('checkpoint-status')).toHaveAttribute('data-state', 'saved');

  await context.close();
  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

type StoredArrangement = { id: string; themeRef: { presetId?: string }; fontId: string | null; themeOverrides: Record<string, unknown> | null; occurrences: { id: string; text: string; durationMs: number | null; visualOverrides: Record<string, unknown> | null }[] };
type StoredState = { key: string; dirty: number; localGeneration: number };

test('AT-17, AT-25, AT-26, AT-30: ajusta, fecha tudo, desliga a rede, recupera em pausa, troca temas e fontes offline e salva no arranjo', async () => {
  test.setTimeout(240_000);
  let context = await profile.open();
  let page = await context.newPage();
  await createSong(page, { durations: ['8', null, '12'], install: true });
  await openOperator(page);
  const operatorUrl = page.url();
  let projection = await openProjection(context, page);
  await page.getByRole('button', { name: 'Automático' }).first().click();
  await startShow(page);

  // Ajustes da sessão: tema (louvor), A+ (este slide), fonte (louvor) e giro da saída.
  await page.locator('[data-theme="violeta"]').click();
  await page.getByRole('group', { name: 'Onde aplicar: fonte' }).getByLabel('Este slide').check();
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await page.getByRole('group', { name: 'Onde aplicar: fonte' }).getByLabel('Todos os slides deste louvor').check();
  await page.locator('[data-font="lato"]').click();
  await page.getByRole('button', { name: '90°' }).click();
  await page.locator('body').press('ArrowRight');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expect(operator(page)).toHaveAttribute('data-overrides-revision', '3');
  await expectConfirmed(page, projection);
  // "Guardado nesta sessão" só depois de o banco confirmar o checkpoint.
  await expect(page.getByTestId('checkpoint-status')).toHaveText('✓ Guardado nesta sessão');
  const sessionId = await operator(page).getAttribute('data-session-id');

  // O operador só alterou a sessão: o arranjo da biblioteca continua como estava.
  let [arrangement] = await readStore<StoredArrangement>(page, 'arrangements');
  expect(arrangement).toMatchObject({ themeRef: { presetId: 'grafite' }, fontId: null, themeOverrides: null });
  const generationBefore = (await readStore<StoredState>(page, 'entityStates')).find((item) => item.key === `arrangement:${arrangement!.id}`)!.localGeneration;
  const [checkpoint] = await readStore<{ sessionId: string; checkpoint: Record<string, unknown> }>(page, 'presentationCheckpoints');
  expect(checkpoint).toMatchObject({ sessionId, checkpoint: { status: 'running', mode: 'automatic', rotation: 90, overrides: { revision: 3 } } });
  // O checkpoint guarda posição efetiva, não uma âncora do relógio monotônico.
  expect(JSON.stringify(checkpoint)).not.toContain('anchor');
  await context.close();

  // ── fecha o navegador, encerra o servidor e reabre sem rede ─────────────
  await server.stop();
  expect(await isReachable()).toBe(false);
  context = await profile.open({ offline: true });
  const fontResponses = new Map<string, boolean>();
  context.on('response', (response) => {
    const file = /\/fonts\/v1\/([a-z0-9-]+\.woff2)$/.exec(response.url())?.[1];
    if (file) fontResponses.set(file, (fontResponses.get(file) ?? true) && response.status() === 200 && response.fromServiceWorker());
  });
  page = await context.newPage();
  const response = await page.goto(operatorUrl);
  expect(response?.fromServiceWorker()).toBe(true);

  // ── AT-17: recuperar em pausa, sem autoplay ─────────────────────────────
  await expect(page.getByTestId('recover-prompt')).toContainText('Em União');
  await page.getByRole('button', { name: 'Recuperar apresentação' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  expect(await operator(page).getAttribute('data-session-id')).toBe(sessionId);
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  await expect(operator(page)).toHaveAttribute('data-rotation', '90');
  await expect(operator(page)).toHaveAttribute('data-overrides-revision', '3');
  expect(await drawn(page, '[data-testid="current-slide"]')).toMatchObject({ text: SLIDE_TEXTS[1], background: rgb('#1B1033'), color: rgb('#EDE9FE'), family: 'Lato' });
  await page.waitForTimeout(3000);
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(operator(page)).toHaveAttribute('data-index', '1');
  expect(await mediaElements(page)).toBe(0);

  // A janela pública também abre sem rede e aguarda o operador armar.
  projection = await openProjection(context, page);
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: SLIDE_TEXTS[1], background: rgb('#1B1033'), family: 'Lato', rotation: '90', inside: true });
  // O ajuste de tamanho ficou só no primeiro slide, como antes de fechar.
  await page.locator('body').press('ArrowLeft');
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.fontSizeRatio).toBeCloseTo(100 / 1920, 4);
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  // Desfazer continua disponível depois de recuperar: sai a fonte Lato, volta a inicial do tema.
  await page.getByRole('button', { name: '↶ Desfazer último ajuste' }).click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.family).toBe('Montserrat');
  await page.getByRole('button', { name: '0°', exact: true }).click();

  // ── AT-26: oito temas; fundo e letra juntos; sem fonte manual, a inicial do tema ──
  for (const [presetId, background, color, family] of THEMES) {
    await page.locator(`[data-theme="${presetId}"]`).click();
    await expectConfirmed(page, projection);
    expect(await drawn(projection), presetId).toMatchObject({ background: rgb(background), color: rgb(color), family });
    expect(await drawn(page, '[data-testid="current-slide"]'), presetId).toMatchObject({ background: rgb(background), color: rgb(color), family });
  }
  // Com fonte escolhida manualmente, ela permanece em todos os temas.
  await page.getByRole('group', { name: 'Onde aplicar: fonte' }).getByLabel('Todos os slides deste louvor').check();
  await page.locator('[data-font="roboto"]').click();
  for (const [presetId, background, color] of THEMES) {
    await page.locator(`[data-theme="${presetId}"]`).click();
    await expectConfirmed(page, projection);
    expect(await drawn(projection), presetId).toMatchObject({ background: rgb(background), color: rgb(color), family: 'Roboto' });
  }
  await page.getByRole('button', { name: 'Usar a fonte inicial do tema' }).click();
  await expectConfirmed(page, projection);
  expect((await drawn(projection))!.family).toBe('Atkinson Hyperlegible');

  // ── AT-25: as oito fontes, regular e negrito, sem rede, na janela pública ──
  await page.locator('[data-theme="grafite"]').click();
  for (const font of manifest.fonts) {
    for (const face of font.faces) {
      await page.locator(`[data-font="${font.fontId}"]`).click();
      await page.getByRole('group', { name: 'Peso da letra' }).getByRole('button', { name: face.weight === 400 ? 'Regular' : 'Negrito' }).click();
      await expectConfirmed(page, projection);
      const label = `${font.family} ${face.weight}`;
      expect(await drawn(projection), label).toMatchObject({ family: font.family, weight: String(face.weight), text: SLIDE_TEXTS[0] });
      const used = await fontInUse(projection, font.family, face.weight);
      expect(used.status, label).toEqual(['loaded']);
      expect(used.withFamily, `${label} não pode ter a largura da fonte de reserva`).not.toBe(used.fallback);
      // Acentos do português desenhados no slide, sem troca de fonte no meio do texto.
      expect((await drawn(projection))!.text).toContain('esperança');
      await expect(page.getByTestId('font-missing')).toHaveCount(0);
    }
  }
  const files = manifest.fonts.flatMap((font) => font.faces.map((face) => face.file));
  expect(files).toHaveLength(16);
  for (const file of files) expect(fontResponses.get(file), `${file} deve vir do service worker`).toBe(true);
  await projection.screenshot({ path: join(EVIDENCE, 'offline-janela-publica.png') });
  await page.screenshot({ path: join(EVIDENCE, 'offline-painel-operador.png') });

  // A seleção persiste: recarregar o operador e recuperar mantém fonte, peso e tema.
  await expect(page.getByTestId('checkpoint-status')).toHaveText('✓ Guardado nesta sessão');
  await page.reload();
  await page.getByRole('button', { name: 'Recuperar apresentação' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  expect(await drawn(page, '[data-testid="current-slide"]')).toMatchObject({ family: 'Atkinson Hyperlegible', weight: '700', background: rgb('#111827') });
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ family: 'Atkinson Hyperlegible', weight: '700' });

  // ── AT-30: salvar os ajustes no arranjo, offline ────────────────────────
  await page.locator('[data-theme="petroleo"]').click();
  await page.getByRole('button', { name: 'Salvar ajustes no arranjo' }).click();
  await expect(page.getByTestId('save-arrangement')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('save-arrangement')).toHaveAttribute('data-conflicts', '0');
  await expect(page.getByTestId('save-arrangement')).toContainText('Salvo no arranjo');
  [arrangement] = await readStore<StoredArrangement>(page, 'arrangements');
  expect(arrangement).toMatchObject({ themeRef: { presetId: 'petroleo' }, fontId: 'atkinson-hyperlegible' });
  expect(arrangement!.occurrences[0]!.visualOverrides).toMatchObject({ fontSizePx: 100 });
  expect(arrangement!.occurrences.map((item) => [item.text, item.durationMs])).toEqual([
    [SLIDE_TEXTS[0], 8000],
    [SLIDE_TEXTS[1], null],
    [SLIDE_TEXTS[2], 12_000],
  ]);
  // Gravado como alteração local pendente, com nova geração.
  expect((await readStore<StoredState>(page, 'entityStates')).find((item) => item.key === `arrangement:${arrangement!.id}`)).toMatchObject({ dirty: 1, localGeneration: generationBefore + 1 });
  // A rotação da saída não vai para o arranjo; fica nas preferências do dispositivo.
  expect(JSON.stringify(arrangement)).not.toContain('rotation');
  // Junto dela ficam o modo escolhido e a aparência "para o louvor inteiro", que valem para a próxima apresentação.
  expect(await readStore(page, 'outputPreferences')).toEqual([
    { outputId: 'public', rotation: 0, mode: 'automatic', appearance: { themePresetId: 'petroleo', fontId: 'atkinson-hyperlegible', fontWeight: 700 } },
  ]);

  // Encerrar e voltar ao editor, ainda sem rede: o arranjo mostra o que foi salvo.
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByLabel('Tema escuro')).toHaveValue('petroleo');
  await expect(page.getByLabel('Fonte', { exact: true })).toHaveValue('atkinson-hyperlegible');
  await expect(output(projection)).toHaveAttribute('data-status', 'ended');
  expect(await readStore(page, 'presentationCheckpoints')).toEqual([]);
  // Sessão encerrada não oferece recuperação.
  await page.getByRole('button', { name: '▶ Apresentar' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
  expect(await operator(page).getAttribute('data-session-id')).not.toBe(sessionId);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('AT-14: proporção 4:3, prévia e saída equivalentes, excesso de texto medido e fonte ausente identificada', async () => {
  test.setTimeout(180_000);
  const context = await profile.open({ blockServiceWorkers: true });
  const page = await context.newPage();
  // O arquivo de uma das fontes não chega: o aplicativo tem de dizer, não esconder.
  await context.route('**/fonts/v1/lato-700.woff2', (route) => route.abort());
  await createSong(page, { durations: [null, null] });
  const cards = page.getByTestId('occurrence');

  // ── troca de proporção ──────────────────────────────────────────────────
  expect((await drawn(page, '[data-testid="occurrence"]'))!.aspect).toBeCloseTo(16 / 9, 2);
  await page.getByLabel('Proporção da projeção').selectOption('4:3');
  await expect.poll(async () => (await drawn(page, '[data-testid="occurrence"]'))!.aspect).toBeCloseTo(4 / 3, 2);

  // ── excesso de texto: linhas visuais medidas com a fonte carregada ──────
  await expect(cards.nth(1).getByTestId('occurrence-excess')).toHaveCount(0);
  const long = 'Bendito seja o nome do Senhor para sempre, em toda a terra e em todo lugar, de geração em geração, agora e eternamente, com gratidão e alegria no coração';
  await cards.nth(1).getByRole('button', { name: 'Editar texto do slide 2' }).click();
  await cards.nth(1).getByLabel('Texto do slide 2').fill(long);
  await cards.nth(1).getByRole('button', { name: 'Concluir' }).click();
  const excess = cards.nth(1).getByTestId('occurrence-excess');
  await expect(excess).toBeVisible();
  // Uma linha de texto só; o aviso conta as linhas que o navegador realmente desenha.
  const laidOut = await cards.nth(1).locator('[data-slide-text]').evaluate((text) => Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)));
  expect(laidOut).toBeGreaterThan(4);
  expect(Number(await excess.getAttribute('data-visual-lines'))).toBe(laidOut);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // ── prévia do operador e saída pública equivalentes ─────────────────────
  await openOperator(page);
  const projection = await openProjection(context, page);
  await startShow(page);
  await expectConfirmed(page, projection);
  const same = async () => {
    const [preview, mirrored, out] = [await drawn(page, '[data-testid="current-slide"]'), await drawn(page, '[data-testid="public-preview"]'), await drawn(projection)];
    for (const [name, other] of [['prévia do slide atual', preview], ['prévia da saída', mirrored]] as const) {
      expect({ text: other!.text, background: other!.background, color: other!.color, family: other!.family, weight: other!.weight, align: other!.align }, name).toEqual({
        text: out!.text,
        background: out!.background,
        color: out!.color,
        family: out!.family,
        weight: out!.weight,
        align: out!.align,
      });
      // Mesma letra em relação à largura da composição, em qualquer tamanho de quadro.
      expect(other!.fontSizeRatio, name).toBeCloseTo(out!.fontSizeRatio, 3);
      expect(other!.aspect, name).toBeCloseTo(out!.aspect, 2);
    }
    return out!;
  };
  expect((await same()).aspect).toBeCloseTo(4 / 3, 2);
  await page.locator('[data-theme="verde-profundo"]').click();
  await expectConfirmed(page, projection);
  expect(await same()).toMatchObject({ background: 'rgb(11, 33, 25)', color: 'rgb(209, 250, 229)', inside: true });
  await projection.screenshot({ path: join(EVIDENCE, 'saida-4x3.png') });

  // ── fonte ausente identificada ──────────────────────────────────────────
  // Verde profundo usa Lato, cujo arquivo em negrito foi bloqueado.
  await expect(page.getByTestId('font-missing')).toBeVisible();
  expect((await fontInUse(projection, 'Lato', 700)).status).toEqual(['error']);
  // A própria janela pública informa o operador; na tela dela nada aparece.
  await expect(page.getByTestId('projection-font-missing')).toBeVisible();
  await slideSettled(projection);
  expect(await projection.evaluate(() => document.body.innerText.trim())).toBe(SLIDE_TEXTS[0]);
  // A recuperação explícita: trocar para Inter, em todos os slides.
  await page.getByRole('group', { name: 'Onde aplicar: fonte' }).getByLabel('Todos os slides deste louvor').check();
  await page.locator('[data-font="inter"]').click();
  await expect(page.getByTestId('font-missing')).toHaveCount(0);
  await expect(page.getByTestId('projection-font-missing')).toHaveCount(0);
  await expectConfirmed(page, projection);
  expect((await fontInUse(projection, 'Inter', 700)).status).toEqual(['loaded']);

  // ── excesso ao vivo: o aviso do operador acompanha o que a saída realmente desenha ──
  /** Altura do texto desenhado na janela pública em relação à área útil (dentro das margens de 8%). */
  const fill = () =>
    projection.evaluate(() => {
      const composition = document.querySelector<HTMLElement>('[data-slide-composition]')!;
      const text = document.querySelector<HTMLElement>('[data-slide-text]')!;
      return text.offsetHeight / (composition.offsetHeight * 0.84);
    });
  await page.locator('body').press('ArrowRight');
  await expectConfirmed(page, projection);
  // No tamanho preparado, o texto longo passa da área útil: o operador é avisado.
  await expect(page.getByTestId('slide-overflow')).toBeVisible();
  expect(await fill()).toBeGreaterThan(1);
  // Reduzir até caber: o aviso de corte some quando o texto de fato cabe.
  for (let step = 0; step < 16 && (await page.getByTestId('slide-overflow').count()) > 0; step += 1) {
    await page.getByRole('button', { name: 'Diminuir a letra' }).click();
  }
  await expect(page.getByTestId('slide-overflow')).toHaveCount(0);
  await expectConfirmed(page, projection);
  expect(await fill()).toBeLessThanOrEqual(1);
  const fitting = Number(await page.getByTestId('menu-font-size').getAttribute('data-font-size'));
  expect(fitting).toBeLessThan(96);
  await expect(page.getByTestId('slide-many-lines')).toBeVisible();
  // Um passo de volta (4 px) corta de novo, e o aviso retorna.
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await expect(page.getByTestId('menu-font-size')).toHaveAttribute('data-font-size', String(fitting + 4));
  await expect(page.getByTestId('slide-overflow')).toBeVisible();
  await expectConfirmed(page, projection);
  expect(await fill()).toBeGreaterThan(1);
  // Limites de A−/A+: 32 e 160 px.
  await page.getByRole('button', { name: 'Tamanho inicial' }).click();
  await expect(page.getByTestId('menu-font-size')).toHaveAttribute('data-font-size', '96');
  for (let step = 0; step < 16; step += 1) await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  await expect(page.getByTestId('menu-font-size')).toHaveAttribute('data-font-size', '160');
  await expect(page.getByRole('button', { name: 'Aumentar a letra' })).toBeDisabled();
  await context.close();
  expect(profile.externalRequests()).toEqual([]);
});

test('abertura, automático por padrão, indicador de avanço automático e preferências entre apresentações', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['3', '3'] });
  // Sem preferência guardada, a apresentação abre no automático, mesmo com o arranjo criado como manual.
  await openOperator(page, { mode: 'preference' });
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  const projection = await openProjection(context, page);
  expect(await drawn(projection)).toMatchObject({ text: '', visualMode: 'black' });

  // ── Iniciar mostra a abertura; nenhum tempo corre até avançar ───────────
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expectConfirmed(page, projection);
  await expect(output(projection)).toHaveAttribute('data-cover', 'true');
  await expect(projection.locator('[data-slide-cover]')).toBeVisible();
  await expect(projection.locator('[data-cover-title]')).toHaveText('Em União');
  await expect(projection.locator('[data-slide-text]')).toHaveCount(0);
  await expect(page.getByTestId('public-summary')).toHaveText('Abertura');
  await expect(page.getByTestId('cover-status')).toBeVisible();
  // Na abertura o botão de avançar ainda é a seta, e o próximo slide é o primeiro da letra.
  await expect(page.getByTestId('advance')).toHaveAttribute('data-auto', 'false');
  await expect(page.getByTestId('auto-spinner')).toHaveCount(0);
  await expect(page.getByTestId('next-slide').locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[0]!);
  await page.waitForTimeout(3500);
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  // Tela preta cobre também a abertura.
  const blackout = page.getByTestId('operator-controls').getByRole('button', { name: 'Tela preta' });
  await blackout.click();
  await expectConfirmed(page, projection);
  await expect(projection.locator('[data-slide-cover]')).toHaveCount(0);
  await blackout.click();

  // ── Avançar: primeiro slide da letra, e a seta vira o indicador girando ──
  await page.getByTestId('advance').click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'false');
  await expectConfirmed(page, projection);
  expect(await drawn(projection)).toMatchObject({ text: SLIDE_TEXTS[0], visible: true });
  await expect(page.getByTestId('advance')).toHaveAttribute('data-auto', 'true');
  await expect(page.getByTestId('advance').getByTestId('auto-spinner')).toBeVisible();
  // Toda troca de slide é suave, não só a saída da abertura: o texto anterior some e só então o novo aparece,
  // no painel e na projeção. A camada que sai dura pouco; aqui se confere a entrada animada e que nada sobra.
  await expect(operator(page)).toHaveAttribute('data-index', '1', { timeout: 6000 });
  for (const frame of [projection.getByTestId('public-output'), page.getByTestId('current-slide')]) {
    await expect(frame.locator('[data-slide-text]')).toHaveText(SLIDE_TEXTS[1]!);
    await expect(frame.locator('.lv-slide-enter')).toHaveCSS('animation-name', 'lv-slide-in');
  }
  await slideSettled(projection);
  await slideSettled(page);
  await expect(projection.locator('.lv-slide-leave')).toHaveCount(0);
  await expect(page.getByTestId('current-slide').locator('.lv-slide-leave')).toHaveCount(0);
  // Em pausa o automático não está andando: a seta volta.
  await page.getByTestId('transport').click();
  await expect(operator(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('advance')).toHaveAttribute('data-auto', 'false');
  await page.getByTestId('transport').click();
  // No modo interativo, o canto inferior direito mostra o mesmo indicador.
  await page.getByRole('button', { name: 'Modo interativo' }).click();
  await expect(page.getByTestId('corner-next').getByTestId('auto-spinner')).toBeVisible();
  await page.getByRole('button', { name: 'Painel completo' }).click();

  // ── Preferências: tema, tamanho e modo valem para a próxima apresentação ──
  await page.locator('[data-theme="violeta"]').click();
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  const size = await page.getByTestId('menu-font-size').getAttribute('data-font-size');
  await page.getByRole('button', { name: 'Manual', exact: true }).first().click();
  await expect(operator(page)).toHaveAttribute('data-mode', 'manual');
  await page.getByRole('button', { name: 'Encerrar' }).click();

  await createSong(page, { title: 'Manhã de Gratidão', durations: [null, null] });
  await openOperator(page, { mode: 'preference' });
  await expect(operator(page)).toHaveAttribute('data-mode', 'manual');
  await expect(page.locator('[data-theme="violeta"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('menu-font-size')).toHaveAttribute('data-font-size', size!);
  expect(await drawn(page, '[data-testid="current-slide"]')).toMatchObject({ background: rgb('#1B1033'), color: rgb('#EDE9FE') });
  // "Restaurar aparência preparada" também limpa a preferência.
  await page.getByRole('button', { name: /Restaurar aparência/ }).click();
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await openOperator(page, { mode: 'preference' });
  await expect(page.locator('[data-theme="violeta"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('menu-font-size')).toHaveAttribute('data-font-size', '96');
  await context.close();
  expect(profile.externalRequests()).toEqual([]);
});
