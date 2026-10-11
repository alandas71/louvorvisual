import { expect, test, type Page } from '@playwright/test';
import { importAudio, wavFile } from './audio.helpers';
import { ORIGIN, ProductionServer } from './helpers';
import { openOperator, operator, SLIDE_TEXTS } from './presentation.helpers';
const server = new ProductionServer();
test.beforeAll(() => server.start());
test.afterAll(() => server.stop());

/** Posição e estado do player que o receptor cria para a faixa enviada pelo celular. */
async function instrumentAudio(page: Page) {
  await page.addInitScript(() => {
    const players: HTMLAudioElement[] = [];
    (window as unknown as { lvPlayers: HTMLAudioElement[] }).lvPlayers = players;
    const Original = window.Audio;
    window.Audio = function (...args: []) { const player = new Original(...args); players.push(player); return player; } as unknown as typeof Audio;
  });
}
const receiverAudio = (page: Page) => page.evaluate(() => {
  const player = (window as unknown as { lvPlayers: HTMLAudioElement[] }).lvPlayers.at(-1);
  return player ? { paused: player.paused, positionMs: player.currentTime * 1000, ready: player.readyState } : null;
});

test('receptor do projetor: código, espera, slides, som no projetor, reconexão e encerramento', async ({ browser }) => {
  const projectorContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const projector = await projectorContext.newPage(); const phone = await phoneContext.newPage();
  const errors: string[] = []; projector.on('pageerror', error => errors.push(error.message)); phone.on('pageerror', error => errors.push(error.message));
  try {
    // O aplicativo do projetor abre /receptor: nenhuma navegação, só o código.
    await instrumentAudio(projector);
    await projector.goto(ORIGIN + '/receptor?receiver=apk');
    await expect(projector.getByTestId('receiver-code')).toHaveText(/^\d{4}$/);
    await expect(projector.getByRole('button')).toHaveCount(0); await expect(projector.getByRole('link')).toHaveCount(0);
    const code = await projector.getByTestId('receiver-code').innerText();
    await projector.screenshot({ path: 'tmp/pwa-receiver-setup.png' });
    await phone.goto(ORIGIN + '/app?view=receptor');
    await phone.getByLabel('Código exibido no projetor').fill(code);
    await phone.getByRole('button', { name: 'Conectar como controle' }).click();
    // Pareado: a espera é só a luz, sem texto.
    await expect(projector.getByTestId('receiver-code')).toHaveCount(0);
    await expect(projector.getByTestId('receiver-waiting')).toBeVisible();
    await expect(projector.getByTestId('pwa-receiver')).toHaveText('');
    await projector.screenshot({ path: 'tmp/pwa-receiver-waiting.png' });

    // Louvor com introdução sem letra e faixa de áudio.
    await phone.goto(`${ORIGIN}/app`);
    await phone.getByRole('button', { name: 'Novo louvor' }).click();
    await phone.getByLabel('Título').fill('Em União');
    await phone.getByLabel('Artista').fill('Coral da Vila');
    await phone.getByLabel('Letra').fill(`[Introdução]\n\n[Estrofe 1]\n${SLIDE_TEXTS[0]}\n\n[Estrofe 2]\n${SLIDE_TEXTS[1]}`);
    await phone.getByRole('button', { name: 'Salvar e revisar slides' }).click();
    await expect(phone.getByTestId('occurrence')).toHaveCount(3);
    await importAudio(phone, 'original', wavFile('faixa.wav', 30));
    await openOperator(phone);
    // Preparada, ainda não iniciada: o público continua na espera.
    await expect(operator(phone)).toHaveAttribute('data-projection-armed', 'true');
    await expect(projector.getByTestId('pwa-receiver')).toHaveAttribute('data-live', 'false');
    await expect(projector.locator('[data-slide-text]')).toHaveCount(0);

    await phone.getByRole('button', { name: '▶ Iniciar', exact: true }).click();
    // Slide inicial de introdução: nome do louvor e artista sobre a luz, não tela preta.
    await expect(projector.getByTestId('pwa-receiver')).toHaveAttribute('data-mode', 'title');
    await expect(projector.getByTestId('receiver-title')).toHaveText('Em UniãoCoral da Vila');
    await expect(projector.getByTestId('receiver-title')).toHaveCSS('opacity', '1');
    await projector.screenshot({ path: 'tmp/pwa-receiver-title.png' });
    // A faixa toca no projetor, perto da posição do celular, e o celular fica mudo.
    // (Faixa independente: quem dá o play é o operador.)
    await phone.getByTestId('audio-toggle').click();
    await expect(operator(phone)).toHaveAttribute('data-audio-playing', 'true');
    await expect.poll(async () => (await receiverAudio(projector))?.paused, { timeout: 20_000 }).toBe(false);
    const phoneAudio = phone.locator('audio[data-testid="session-audio"]');
    await expect.poll(() => phoneAudio.evaluate((audio: HTMLAudioElement) => audio.muted), { timeout: 10_000 }).toBe(true);
    await expect(phone.getByTestId('audio-output')).toHaveAttribute('data-state', 'projector');
    await expect.poll(async () => {
      const [there, here] = await Promise.all([receiverAudio(projector), phoneAudio.evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000)]);
      return Math.abs((there?.positionMs ?? -9999) - here);
    }, { timeout: 15_000 }).toBeLessThan(300);

    const text = projector.locator('[data-slide-text]');
    const sent = Date.now();
    await phone.keyboard.press('ArrowRight'); await expect(text).toHaveText(SLIDE_TEXTS[0]!);
    console.log(`troca de slide no projetor em ${Date.now() - sent} ms`);
    // A letra fica sobre a luz: o slide não pinta fundo próprio e a introdução esmaece.
    await expect(projector.locator('[data-slide-frame]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(projector.getByTestId('receiver-title')).toHaveCSS('opacity', '0');
    await projector.screenshot({ path: 'tmp/pwa-receiver-lyrics.png' });
    await phone.keyboard.press('ArrowRight'); await expect(text).toHaveText(SLIDE_TEXTS[1]!);
    await phone.keyboard.press('b'); await expect(projector.getByTestId('pwa-receiver')).toHaveAttribute('data-mode', 'black');
    await phone.keyboard.press('b'); await expect(projector.getByTestId('pwa-receiver')).toHaveAttribute('data-mode', 'slide');
    await projectorContext.setOffline(true);
    await expect(operator(phone)).toHaveAttribute('data-projection', 'lost', { timeout: 20_000 });
    // Sem projetor, o som volta ao celular.
    await expect.poll(() => phoneAudio.evaluate((audio: HTMLAudioElement) => audio.muted), { timeout: 15_000 }).toBe(false);
    await phone.keyboard.press('ArrowLeft'); await projectorContext.setOffline(false);
    await expect(text).toHaveText(SLIDE_TEXTS[0]!); await expect(operator(phone)).toHaveAttribute('data-projection-armed', 'true');
    await projector.screenshot({ path: 'tmp/pwa-receiver-screen.png' });
    // Reload restores the paired receiver and immediately returns to the output.
    await projector.reload(); await expect(text).toHaveText(SLIDE_TEXTS[0]!);
    await phone.getByRole('button', { name: /Encerrar/ }).click();
    await expect(projector.locator('[data-slide-text]')).toHaveCount(0);
    await expect(projector.getByTestId('receiver-waiting')).toBeVisible();
    await expect.poll(async () => (await receiverAudio(projector))?.paused ?? true).toBe(true);
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await projectorContext.close(); }
});

test('receptor dentro do PWA: um navegador ligado ao projetor também serve de saída', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto(ORIGIN + '/app');
    await page.getByRole('link', { name: 'Projetor e celular' }).click();
    await page.getByRole('button', { name: 'Ativar receptor neste dispositivo' }).click();
    await expect(page.getByTestId('receiver-code')).toHaveText(/^\d{4}$/);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  } finally { await context.close(); }
});
