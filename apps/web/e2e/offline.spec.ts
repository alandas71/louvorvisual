import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BrowserProfile, isReachable, ORIGIN, ProductionServer, waitUntilInstalled } from './helpers';

type Manifest = { version: string; fonts: { fontId: string; family: string; faces: { weight: number; file: string; sha256: string }[] }[] };
const manifest: Manifest = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'fonts', 'v1', 'manifest.json'), 'utf8'));
const THEMES = ['grafite', 'azul-noturno', 'violeta', 'verde-profundo', 'vinho', 'ambar', 'petroleo', 'preto-acessivel'];

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

/** Abre uma rota sem rede e confere que o documento veio do service worker. */
async function openOffline(page: Page, path: string) {
  const response = await page.goto(`${ORIGIN}${path}`);
  expect(response?.status(), path).toBe(200);
  expect(response?.fromServiceWorker(), `${path} deve vir do service worker`).toBe(true);
}

test('abre /app e /projecao, fecha o navegador, desliga a rede e reabre as duas', async () => {
  let context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app`);
  const installed = await waitUntilInstalled(page);
  expect(installed.cached).toBe(installed.expected);
  await page.goto(`${ORIGIN}/projecao`);
  await expect(page.getByTestId('public-output')).toHaveAttribute('data-status', 'no-session');
  await context.close();

  await server.stop();
  expect(await isReachable()).toBe(false);

  context = await profile.open({ offline: true });
  const offlinePage = await context.newPage();
  await openOffline(offlinePage, '/app');
  await expect(offlinePage.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
  // O shell está interativo: trocar de vista não pede nada ao servidor.
  await offlinePage.getByRole('link', { name: 'Disponível offline' }).click();
  await expect(offlinePage).toHaveURL(`${ORIGIN}/app?view=offline`);
  await expect(offlinePage.getByTestId('offline-phase')).toHaveAttribute('data-phase', 'ready');
  await expect(offlinePage.getByTestId('app-version')).toHaveText(installed.version);

  await openOffline(offlinePage, '/projecao');
  await expect(offlinePage.getByTestId('public-output')).toHaveAttribute('data-status', 'no-session');
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('abre offline rotas e vistas que nunca foram visitadas', async () => {
  let context = await profile.open();
  const page = await context.newPage();
  // Única visita com rede: /app, na vista padrão.
  await page.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(page);
  await context.close();
  expect(profile.navigated).toEqual([`${ORIGIN}/app`]);

  await server.stop();

  context = await profile.open({ offline: true });
  const offlinePage = await context.newPage();
  // Sessão que não existe: a janela pública abre, fica preta e espera o operador.
  await openOffline(offlinePage, '/projecao?session=6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d');
  await expect(offlinePage.getByTestId('public-output')).toHaveAttribute('data-status', 'waiting');
  await expect(offlinePage.getByTestId('setup-connection')).toHaveText('Aguardando o painel do operador…');
  await expect(offlinePage.locator('[data-slide-text]')).toHaveCount(0);

  await openOffline(offlinePage, '/app?view=temas&tema=violeta&fonte=lato&peso=400');
  await expect(offlinePage.locator('[data-slide-text]').first()).toContainText('gratidão');
  await expect(offlinePage.locator('[data-slide-frame]').first()).toHaveCSS('background-color', 'rgb(27, 16, 51)');

  await openOffline(offlinePage, '/app?view=temas&tema=ambar');
  await expect(offlinePage.getByRole('heading', { name: 'Temas e fontes' })).toBeVisible();
  await expect(offlinePage.getByRole('button', { name: /Âmbar/ })).toHaveAttribute('aria-pressed', 'true');

  await openOffline(offlinePage, '/');
  await expect(offlinePage.getByRole('link', { name: 'Abrir o aplicativo' })).toBeVisible();
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('carrega as dezesseis fontes do pacote sem rede e sem pedidos remotos', async () => {
  let context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(page);
  await context.close();
  // Com rede só a vista padrão foi aberta; nenhuma fonte foi selecionada.
  await server.stop();

  context = await profile.open({ offline: true });
  const offlinePage = await context.newPage();
  const fontResponses = new Map<string, boolean>();
  offlinePage.on('response', (response) => {
    const match = /\/fonts\/v1\/([a-z0-9-]+\.woff2)$/.exec(response.url());
    if (match?.[1]) fontResponses.set(match[1], response.status() === 200 && response.fromServiceWorker());
  });

  const faces = manifest.fonts.flatMap((font) => font.faces.map((face) => ({ ...face, fontId: font.fontId, family: font.family })));
  expect(faces).toHaveLength(16);

  for (const [index, face] of faces.entries()) {
    const theme = THEMES[index % THEMES.length];
    // A prévia de temas usa o mesmo SlideRenderer da projeção.
    await openOffline(offlinePage, `/app?view=temas&tema=${theme}&fonte=${face.fontId}&peso=${face.weight}`);
    await expect(offlinePage.locator('[data-slide-text]').first()).toContainText('gratidão');
    const result = await offlinePage.evaluate(
      async ({ family, weight, file }) => {
        await document.fonts.ready;
        const text = document.querySelector<HTMLElement>('[data-slide-text]')!;
        const computed = getComputedStyle(text);
        const declared = [...document.fonts].filter((item) => item.family.replace(/["']/g, '') === family && item.weight === String(weight));

        // Largura do mesmo texto com a família e só com a fonte de reserva:
        // se forem iguais, o que está na tela é a reserva.
        const measure = (fontFamily: string) => {
          const span = document.createElement('span');
          span.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:96px;font-weight:${weight};font-family:${fontFamily}`;
          span.textContent = 'Coração, louvação, fé e canção ÁÀÂÃÉÊÍÓÔÕÚÜÇ';
          document.body.append(span);
          const width = span.getBoundingClientRect().width;
          span.remove();
          return width;
        };

        const bytes = await (await fetch(`/fonts/v1/${file}`)).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return {
          usedFamily: computed.fontFamily.split(',')[0]?.replace(/["']/g, ''),
          usedWeight: computed.fontWeight,
          declaredStatus: declared.map((item) => item.status),
          widthWithFamily: measure(`"${family}", monospace`),
          widthFallback: measure('monospace'),
          sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
        };
      },
      { family: face.family, weight: face.weight, file: face.file },
    );

    const label = `${face.family} ${face.weight}`;
    expect(result.usedFamily, label).toBe(face.family);
    expect(result.usedWeight, label).toBe(String(face.weight));
    expect(result.declaredStatus, label).toEqual(['loaded']);
    expect(result.widthWithFamily, `${label} não pode ter a largura da fonte de reserva`).not.toBe(result.widthFallback);
    expect(result.sha256, label).toBe(face.sha256);
    expect(fontResponses.get(face.file), `${face.file} deve vir do service worker`).toBe(true);
  }
  expect([...fontResponses.keys()].sort()).toEqual(faces.map((face) => face.file).sort());

  // A verificação do próprio aplicativo chega ao mesmo resultado.
  await openOffline(offlinePage, '/app?view=offline');
  await expect(offlinePage.getByTestId('font-summary')).toHaveAttribute('data-ok', '16');
  await expect(offlinePage.getByTestId('font-check')).toHaveCount(16);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});
