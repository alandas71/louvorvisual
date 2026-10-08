import { expect, test } from '@playwright/test';
import { BrowserProfile, ProductionServer } from './helpers';
import { createSong, openOperator, operator } from './presentation.helpers';

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

test('modos de avanço: sem temporizador da introdução só há manual e semi-automático; com ele, o automático mostra a letra sozinho', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: ['8', '8'] });

  // Sem temporizador da introdução: o automático aparece desligado e a abertura espera o operador.
  await openOperator(page, { mode: 'preference' });
  await expect(operator(page)).toHaveAttribute('data-mode', 'automatic');
  await expect(page.getByTestId('mode-automatic').first()).toBeDisabled();
  await expect(page.getByTestId('mode-semi').first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expect(page.getByTestId('cover-status')).toContainText('avance para mostrar a letra');
  await page.waitForTimeout(2500);
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await page.getByRole('button', { name: 'Encerrar' }).click();

  // O temporizador da introdução é definido no editor, nunca durante a apresentação.
  const intro = page.getByTestId('intro-timer');
  await expect(intro).toBeVisible();
  await intro.getByRole('button', { name: 'Adicionar tempo ao início (introdução)' }).click();
  const field = intro.getByLabel('Tempo do início (introdução), em segundos');
  await field.fill('3');
  await field.press('Enter');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await openOperator(page, { mode: 'preference' });
  await expect(operator(page)).toHaveAttribute('data-intro-ms', '3000');
  await expect(page.getByTestId('mode-automatic').first()).toBeEnabled();
  await expect(page.getByTestId('mode-automatic').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('live-menu').getByTestId('intro-timer-info')).toContainText('3 s');
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expect(page.getByTestId('cover-status')).toContainText('a letra entra sozinha');
  // Ninguém avança: a letra entra quando a introdução termina, e o primeiro slide segue no seu tempo.
  await expect(operator(page)).toHaveAttribute('data-cover', 'false', { timeout: 6000 });
  await expect(operator(page)).toHaveAttribute('data-index', '0');
  await page.getByRole('button', { name: '■ Parar' }).click();

  // Semi-automático com o mesmo louvor: a abertura volta a esperar o operador.
  await page.getByTestId('mode-semi').first().click();
  await expect(operator(page)).toHaveAttribute('data-intro-auto', 'false');
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await page.waitForTimeout(4000);
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await page.getByTestId('advance').click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'false');

  await context.close();
});
