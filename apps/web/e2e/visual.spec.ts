import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BrowserProfile, ORIGIN, ProductionServer } from './helpers';
import { createSong, openOperator, startShow } from './presentation.helpers';

// Passeio visual: abre cada tela nos tamanhos de computador e de celular, grava
// a captura em test-results/visual e confere o que nenhuma tela pode ter —
// rolagem horizontal e alvos de toque pequenos demais na navegação.
const SHOTS = join(__dirname, '..', 'test-results', 'visual');

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const server = new ProductionServer();
let profile: BrowserProfile;

test.beforeEach(async () => {
  profile = new BrowserProfile();
  await server.start();
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async () => {
  await server.stop();
  profile.remove();
});

async function capture(page: Page, size: string, name: string): Promise<void> {
  // As animações de entrada terminam antes da captura.
  await page.waitForTimeout(350);
  // Barras fixas são desenhadas onde a rolagem estiver: a captura inteira parte do topo.
  await page.evaluate(() => window.scrollTo(0, 0));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect.soft(overflow, `rolagem horizontal em "${name}" (${size})`).toBeLessThanOrEqual(1);
  await page.screenshot({ path: join(SHOTS, `${size}-${name}.png`), fullPage: true });
}

async function openView(page: Page, view: string): Promise<void> {
  await page.goto(`${ORIGIN}/app?view=${view}`);
  await expect(page.locator('main')).toHaveAttribute('data-view', view);
  await expect(page.locator('main h1, main h2').first()).toBeVisible();
}

for (const size of SIZES) {
  test(`passeio visual em ${size.name} (${size.width}×${size.height})`, async () => {
    test.setTimeout(240_000);
    const context = await profile.open();
    const page = await context.newPage();
    await page.setViewportSize({ width: size.width, height: size.height });

    await page.goto(`${ORIGIN}/`);
    await capture(page, size.name, '00-entrada');

    await openView(page, 'biblioteca');
    await capture(page, size.name, '01-biblioteca-vazia');

    await page.getByRole('button', { name: 'Novo louvor' }).click();
    await expect(page.getByLabel('Título')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();
    await capture(page, size.name, '02-novo-louvor-erro');

    await createSong(page, { durations: ['8', null, '12', null], notes: 'Entrar depois da leitura.' });
    await capture(page, size.name, '03-editor');
    await createSong(page, { title: 'Manhã de Gratidão', durations: [null, null] });

    await openView(page, 'biblioteca');
    await expect(page.getByTestId('library-item')).toHaveCount(2);
    await capture(page, size.name, '04-biblioteca');
    await page.getByRole('button', { name: 'Excluir Manhã de Gratidão' }).click();
    await capture(page, size.name, '05-biblioteca-confirmacao');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await openView(page, 'repertorios');
    await capture(page, size.name, '06-repertorios-vazio');
    await page.getByLabel('Nome do repertório').fill('Culto de domingo');
    await page.getByRole('button', { name: 'Criar repertório' }).click();
    await page.getByLabel('Acrescentar louvor').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
    await page.getByLabel('Acrescentar louvor').selectOption({ index: 2 });
    await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
    await expect(page.getByTestId('setlist-item')).toHaveCount(2);
    await capture(page, size.name, '07-repertorio');
    await openView(page, 'repertorios');
    await expect(page.getByTestId('setlist-row')).toHaveCount(1);
    await capture(page, size.name, '08-repertorios');

    for (const [index, view] of ['temas', 'lixeira', 'offline', 'sync', 'conta'].entries()) {
      await openView(page, view);
      await capture(page, size.name, `${String(index + 9).padStart(2, '0')}-${view}`);
    }

    await openView(page, 'temas');
    await page.getByRole('button', { name: 'Duplicar tema' }).click();
    await expect(page.getByTestId('custom-theme-form')).toBeVisible();
    await capture(page, size.name, '14-tema-personalizado');

    await openView(page, 'biblioteca');
    await page.getByRole('link', { name: /Em União/ }).first().click();
    await openOperator(page);
    await capture(page, size.name, '15-operador');
    await startShow(page);
    await capture(page, size.name, '16-operador-em-andamento');
    await page.getByRole('button', { name: 'Modo interativo' }).click();
    await expect(page.getByTestId('interactive-stage')).toBeVisible();
    await page.getByTestId('corner-menu').focus();
    await capture(page, size.name, '17-modo-interativo');
    await page.getByTestId('corner-menu').click();
    await expect(page.getByTestId('live-menu')).toBeVisible();
    await capture(page, size.name, '18-menu-ao-vivo');

    await page.goto(`${ORIGIN}/projecao`);
    await capture(page, size.name, '19-projecao');

    await context.close();
    expect(profile.consoleErrors.filter((text) => !/^Failed to load resource/.test(text))).toEqual([]);
  });
}

test('celular: barra inferior, menu "Mais" e manifesto do aplicativo instalável', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/app`);
  await expect(page.locator('main')).toHaveAttribute('data-view', 'biblioteca');

  // A navegação lateral fica fora da tela e da ordem de foco; a barra inferior é a navegação.
  const bar = page.getByRole('navigation', { name: 'Navegação rápida' });
  await expect(bar).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Áreas do aplicativo' })).toBeHidden();
  for (const target of await bar.locator('a, button').all()) {
    const box = (await target.boundingBox())!;
    expect(Math.min(box.width, box.height), 'alvo de toque da barra inferior').toBeGreaterThanOrEqual(44);
  }
  // A barra não cobre o fim do conteúdo: o último elemento rola até ficar acima dela.
  const barTop = (await bar.boundingBox())!.y;
  expect(barTop).toBeGreaterThan(700);

  await bar.getByRole('link', { name: 'Conta' }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'conta');
  await expect(bar.getByRole('link', { name: 'Conta' })).toHaveAttribute('aria-current', 'page');
  // Repertórios e temas estão ocultos: fora da barra e do menu, mas abrem pelo endereço.
  await expect(bar.getByRole('link', { name: 'Repertórios' })).toHaveCount(0);

  // "Mais" abre o menu completo, com foco dentro dele; Esc fecha e devolve o foco.
  const more = bar.getByRole('button', { name: 'Mais' });
  await more.click();
  const menu = page.getByRole('navigation', { name: 'Áreas do aplicativo' });
  await expect(menu).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fechar o menu' })).toBeFocused();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, 'mobile-20-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  await more.click();
  await menu.getByRole('link', { name: 'Disponível offline' }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'offline');
  await expect(menu).toBeHidden();
  // Fora das três áreas da barra, o último botão mostra onde a pessoa está.
  await expect(bar.getByRole('button', { name: 'Offline' })).toBeVisible();

  // Manifesto: instalável, com atalhos e ícones que existem.
  const manifest = await (await context.request.get(`${ORIGIN}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/app', scope: '/' });
  expect(manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url)).toEqual(['/app?view=novo', '/projecao']);
  const icons = [...manifest.icons.map((icon: { src: string }) => icon.src), '/icons/apple-touch-icon.png'];
  for (const src of icons) expect((await context.request.get(`${ORIGIN}${src}`)).status(), src).toBe(200);
  expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(true);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /apple-touch-icon\.png/);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

  // O atalho "Novo louvor" abre direto o cadastro, com o foco no título.
  await page.goto(`${ORIGIN}/app?view=novo`);
  await expect(page.getByLabel('Título')).toBeFocused();

  await context.close();
  expect(profile.consoleErrors.filter((text) => !/^Failed to load resource/.test(text))).toEqual([]);
});
