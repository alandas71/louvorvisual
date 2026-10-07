import { expect, test } from '@playwright/test';
import { BrowserProfile, cacheNames, ORIGIN, ProductionServer, publishServiceWorker, waitUntilInstalled } from './helpers';

// Estes testes trocam public/sw.js para simular a publicação de outra versão.
let currentVersion: string;
const server = new ProductionServer();
let profile: BrowserProfile;

test.beforeEach(async () => {
  currentVersion = publishServiceWorker();
  profile = new BrowserProfile();
  await server.start();
});

test.afterEach(async () => {
  await server.stop();
  profile.remove();
  publishServiceWorker();
});

test('versão nova espera em cache separado, não entra com a projeção aberta e entra a pedido', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app?view=offline`);
  await waitUntilInstalled(page);
  await expect(page.getByTestId('app-version')).toHaveText(currentVersion);
  expect(await cacheNames(page)).toEqual([`lv-precache-${currentVersion}`]);

  const nextVersion = publishServiceWorker({ salt: 'e2e-nova-versao' });
  expect(nextVersion).not.toBe(currentVersion);

  // A versão nova é baixada inteira, mas a janela continua na anterior.
  await page.getByRole('button', { name: 'Procurar versão nova' }).click();
  await expect(page.getByTestId('update-waiting')).toBeVisible();
  await expect(page.getByTestId('app-version')).toHaveText(currentVersion);
  expect((await cacheNames(page)).sort()).toEqual([`lv-precache-${currentVersion}`, `lv-precache-${nextVersion}`].sort());
  expect(page.url()).toBe(`${ORIGIN}/app?view=offline`);

  // Com a projeção aberta, o pedido de atualização é recusado.
  const projection = await context.newPage();
  await projection.goto(`${ORIGIN}/projecao`);
  await expect(projection.getByTestId('public-output')).toBeVisible();
  await page.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(page.getByTestId('update-blocked')).toContainText('janela de projeção aberta');
  await expect(page.getByTestId('app-version')).toHaveText(currentVersion);
  expect((await waitUntilInstalled(projection)).version).toBe(currentVersion);
  expect(await cacheNames(page)).toHaveLength(2);

  // Fechada a projeção, a troca acontece e o cache antigo é removido.
  await projection.close();
  await page.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(page.getByTestId('app-version')).toHaveText(nextVersion);
  await expect(page.getByTestId('update-waiting')).toHaveCount(0);
  // A limpeza termina logo depois de a versão nova assumir.
  await expect.poll(() => cacheNames(page)).toEqual([`lv-precache-${nextVersion}`]);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
});

test('instalação de versão com arquivo diferente do build falha e a versão anterior continua abrindo offline', async () => {
  let context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app?view=offline`);
  await waitUntilInstalled(page);

  publishServiceWorker({ salt: 'e2e-versao-quebrada', tamper: '/fonts/v1/lato-700.woff2' });

  const failed = page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const installing = new Promise<ServiceWorker>((resolve) => {
      registration.addEventListener('updatefound', () => resolve(registration.installing!), { once: true });
    });
    await registration.update();
    const worker = await installing;
    await new Promise<void>((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'redundant' || worker.state === 'installed') resolve();
      });
    });
    return { state: worker.state, waiting: Boolean(registration.waiting) };
  });
  expect(await failed).toEqual({ state: 'redundant', waiting: false });

  // Nada da versão recusada ficou para trás, e a anterior segue completa.
  expect(await cacheNames(page)).toEqual([`lv-precache-${currentVersion}`]);
  const status = await waitUntilInstalled(page);
  expect(status).toMatchObject({ version: currentVersion, cached: status.expected });
  await expect(page.getByTestId('update-waiting')).toHaveCount(0);
  await context.close();

  await server.stop();
  context = await profile.open({ offline: true });
  const offlinePage = await context.newPage();
  const response = await offlinePage.goto(`${ORIGIN}/app?view=temas&fonte=lato&peso=700`);
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(offlinePage.locator('[data-slide-text]').first()).toContainText('gratidão');
  await context.close();
});
