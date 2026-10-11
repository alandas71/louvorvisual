import { expect, test } from '@playwright/test';
import { ORIGIN, ProductionServer } from './helpers';
import { createSong, openOperator, operator, SLIDE_TEXTS } from './presentation.helpers';
const server = new ProductionServer();
test.beforeAll(() => server.start());
test.afterAll(() => server.stop());
test('PWA receptor: celular e projetor isolados, slides, reconexão e encerramento', async ({ browser }) => {
  const projectorContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const projector = await projectorContext.newPage(); const phone = await phoneContext.newPage();
  const errors: string[] = []; projector.on('pageerror', error => errors.push(error.message)); phone.on('pageerror', error => errors.push(error.message));
  try {
    await projector.goto(ORIGIN + '/app');
    await expect(projector.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await projector.getByRole('link', { name: 'Projetor e celular' }).click();
    await projector.getByRole('button', { name: 'Ativar receptor neste dispositivo' }).click();
    const code = await projector.getByTestId('receiver-code').innerText();
    await projector.screenshot({ path: 'tmp/pwa-receiver-setup.png' });
    await phone.goto(ORIGIN + '/app?view=receptor');
    await phone.screenshot({ path: 'tmp/pwa-receiver-phone.png' });
    await phone.getByLabel('Código exibido no projetor').fill(code);
    await phone.getByRole('button', { name: 'Conectar como controle' }).click();
    await expect(projector.getByRole('status')).toHaveText('Celular conectado.');
    await projector.getByRole('button', { name: 'Exibir apresentação' }).click();
    await createSong(phone, { durations: [null, null] }); await openOperator(phone);
    await expect(operator(phone)).toHaveAttribute('data-projection-armed', 'true');
    await phone.getByRole('button', { name: '▶ Iniciar', exact: true }).click();
    const text = projector.locator('[data-slide-text]');
    await expect(text).toHaveText(SLIDE_TEXTS[0]!);
    await phone.keyboard.press('ArrowRight'); await expect(text).toHaveText(SLIDE_TEXTS[1]!);
    await phone.keyboard.press('b'); await expect(projector.locator('[data-slide-frame]')).toHaveAttribute('data-visual-mode', 'black');
    await phone.keyboard.press('b');
    await projectorContext.setOffline(true);
    await expect(operator(phone)).toHaveAttribute('data-projection', 'lost', { timeout: 15_000 });
    await phone.keyboard.press('ArrowLeft'); await projectorContext.setOffline(false);
    await expect(text).toHaveText(SLIDE_TEXTS[0]!); await expect(operator(phone)).toHaveAttribute('data-projection-armed', 'true');
    await projector.screenshot({ path: 'tmp/pwa-receiver-screen.png' });
    // Reload restores pairing, but requires arming again before exposing slides.
    await projector.reload(); await expect(projector.getByRole('status')).toHaveText('Celular conectado.');
    await projector.getByRole('button', { name: 'Exibir apresentação' }).click(); await expect(text).toHaveText(SLIDE_TEXTS[0]!);
    await phone.getByRole('button', { name: /Encerrar/ }).click();
    await expect(projector.locator('[data-slide-text]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await projectorContext.close(); }
});
