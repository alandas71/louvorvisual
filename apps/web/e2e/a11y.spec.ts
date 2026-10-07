import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BrowserProfile, ORIGIN, ProductionServer } from './helpers';
import { createSong, openOperator, openProjection } from './presentation.helpers';

// Auditoria de acessibilidade (RNF-06) sobre o build de produção: regras WCAG 2.1 A/AA
// do axe-core em cada tela do operador, mais a operação principal só pelo teclado.
const axeSource = readFileSync(createRequire(__filename).resolve('axe-core/axe.min.js'), 'utf8');
const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '15-evidencias');

type Violation = { id: string; impact: string | null; help: string; nodes: { target: string[]; html: string; failureSummary: string }[] };
type Audit = { screen: string; violations: Violation[]; incomplete: { id: string; nodes: number }[]; passes: number };

const audits: Audit[] = [];

async function audit(page: Page, screen: string): Promise<Audit> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: Violation[]; incomplete: Violation[]; passes: unknown[] }> } }).axe;
    const { violations, incomplete, passes } = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations', 'incomplete', 'passes'] });
    const trim = (items: Violation[]) => items.map(({ id, impact, help, nodes }) => ({ id, impact, help, nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html: html.slice(0, 200), failureSummary })) }));
    return { violations: trim(violations), incomplete: incomplete.map((item) => ({ id: item.id, nodes: item.nodes.length })), passes: passes.length };
  });
  const entry = { screen, ...result };
  audits.push(entry);
  return entry;
}

/** Falha mostrando regra, elemento e motivo; a lista completa fica no JSON de evidência. */
function expectClean(entry: Audit): void {
  const summary = entry.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id} (${violation.impact}) ${node.target.join(' ')} — ${node.failureSummary.replace(/\s+/g, ' ')}`));
  expect.soft(summary, `acessibilidade em "${entry.screen}"`).toEqual([]);
}

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

/** Erros do console, menos o aviso do navegador para a API ausente (a tela de conta consulta /api sem servidor). */
const appErrors = () => profile.consoleErrors.filter((text) => !/^Failed to load resource/.test(text));

test('RNF-06: nenhuma violação WCAG 2.1 A/AA nas telas do aplicativo, do operador e da projeção', async () => {
  test.setTimeout(240_000);
  const context = await profile.open();
  // Nenhum arquivo do aplicativo pode faltar; só a API, que não está no ar nesta prova.
  const missing: string[] = [];
  context.on('response', (response) => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) missing.push(`${response.status()} ${response.url()}`);
  });
  const page = await context.newPage();

  await page.goto(`${ORIGIN}/`);
  expectClean(await audit(page, 'entrada'));

  // Telas vazias: é como a pessoa nova encontra o aplicativo.
  for (const view of ['biblioteca', 'repertorios', 'temas', 'lixeira', 'offline', 'sync', 'conta']) {
    await page.goto(`${ORIGIN}/app?view=${view}`);
    await expect(page.locator('main')).toHaveAttribute('data-view', view);
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    expectClean(await audit(page, `${view} (vazia)`));
  }

  await page.goto(`${ORIGIN}/app`);
  await page.getByRole('button', { name: 'Novo louvor' }).click();
  await expect(page.getByLabel('Título')).toBeVisible();
  // Erro de validação visível: título obrigatório.
  await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();
  expectClean(await audit(page, 'novo louvor (com erro de validação)'));

  await createSong(page, { durations: ['8', null, '12'], notes: 'Entrar depois da leitura.' });
  expectClean(await audit(page, 'editor'));

  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'biblioteca');
  expectClean(await audit(page, 'biblioteca (com louvor)'));

  await page.getByRole('link', { name: 'Repertórios' }).click();
  await page.getByLabel('Nome do repertório').fill('Culto de domingo');
  await page.getByRole('button', { name: 'Criar repertório' }).click();
  await page.getByLabel('Acrescentar louvor').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Acrescentar', exact: true }).click();
  await expect(page.getByTestId('setlist-item')).toHaveCount(1);
  expectClean(await audit(page, 'repertório (com item)'));

  for (const view of ['temas', 'lixeira', 'offline']) {
    await page.goto(`${ORIGIN}/app?view=${view}`);
    await expect(page.locator('main')).toHaveAttribute('data-view', view);
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    expectClean(await audit(page, `${view} (com conteúdo)`));
  }

  // Tema personalizado em edição, com a recusa de fundo claro à vista.
  await page.goto(`${ORIGIN}/app?view=temas`);
  await page.getByRole('button', { name: 'Duplicar tema' }).click();
  await expect(page.getByTestId('custom-theme-form')).toBeVisible();
  expectClean(await audit(page, 'temas (editando tema personalizado)'));
  await page.getByLabel('Cor do fundo', { exact: true }).fill('#FFFFFF');
  await expect(page.getByTestId('custom-theme-issues')).toBeVisible();
  expectClean(await audit(page, 'temas (tema personalizado recusado)'));

  // Operador: painel completo, modo interativo com controles e menu aberto.
  await page.goto(`${ORIGIN}/app`);
  await page.getByRole('link', { name: /Em União/ }).first().click();
  await openOperator(page);
  expectClean(await audit(page, 'operador (painel, antes de iniciar)'));
  const projection = await openProjection(context, page, { arm: false });
  expectClean(await audit(projection, 'projeção (preparação, antes de armar)'));
  await projection.getByRole('button', { name: 'Armar saída' }).click();
  await expect(projection.getByTestId('public-output')).toHaveAttribute('data-armed', 'true');
  expectClean(await audit(projection, 'projeção (saída limpa)'));
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  expectClean(await audit(page, 'operador (painel, em andamento)'));

  await page.getByRole('button', { name: 'Modo interativo' }).click();
  const stage = page.getByTestId('interactive-stage');
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  await page.getByTestId('corner-menu').focus();
  expectClean(await audit(page, 'operador (modo interativo, controles visíveis)'));
  await page.getByTestId('corner-menu').click();
  await expect(page.getByTestId('live-menu')).toBeVisible();
  expectClean(await audit(page, 'operador (modo interativo, menu aberto)'));

  await context.close();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'acessibilidade-axe.json'), `${JSON.stringify({ engine: 'axe-core', tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], audits }, null, 2)}\n`);
  expect(missing).toEqual([]);
  expect(appErrors()).toEqual([]);
});

test('RNF-06: operação principal só pelo teclado, com foco sempre visível', async () => {
  test.setTimeout(120_000);
  const context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app`);
  await expect(page.locator('main')).toHaveAttribute('data-view', 'biblioteca');

  /** O elemento com foco e se o navegador desenha um indicador nele (contorno, anel ou borda diferente). */
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? element.tagName,
        tag: element.tagName,
        indicator: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1) || style.boxShadow !== 'none',
        onScreen: box.width > 0 && box.height > 0,
      };
    });

  // O primeiro Tab é o atalho para o conteúdo, e ele leva ao conteúdo.
  await expect(page.getByRole('button', { name: 'Novo louvor' })).toBeVisible();
  await page.keyboard.press('Tab');
  expect((await focused())?.name).toMatch(/conteúdo/i);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main-content');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#main-content')))).toBe(true);

  // Percorre a página inteira por Tab: todo foco é visível e nenhum fica fora da tela.
  await page.goto(`${ORIGIN}/app`);
  await expect(page.getByRole('button', { name: 'Novo louvor' })).toBeVisible();
  const stops: NonNullable<Awaited<ReturnType<typeof focused>>>[] = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const stop = await focused();
    if (!stop) break;
    stops.push(stop);
  }
  expect(stops.length).toBeGreaterThan(5);
  // O atalho para o conteúdo só existe na tela enquanto tem foco: aparecer é o indicador dele.
  expect(stops.filter((stop) => !stop.onScreen || (!stop.indicator && !/^Pular para o conteúdo/.test(stop.name)))).toEqual([]);

  // Cadastra, configura tempo e apresenta sem tocar no mouse.
  const tabTo = async (name: string | RegExp, limit = 60) => {
    for (let step = 0; step < limit; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await focused();
      if (stop && (typeof name === 'string' ? stop.name === name : name.test(stop.name))) return;
    }
    throw new Error(`"${name}" não foi alcançado por Tab`);
  };
  await page.goto(`${ORIGIN}/app`);
  await expect(page.getByRole('button', { name: 'Novo louvor' })).toBeVisible();
  await tabTo('Novo louvor');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Título')).toBeFocused();
  await page.keyboard.type('Em União');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Coral da Vila');
  await page.getByLabel('Letra').focus();
  await page.keyboard.type('[Estrofe 1]\nHoje cantamos em união\n\n[Estrofe 2]\nCom alegria no coração');
  await tabTo('Salvar e revisar slides');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('occurrence')).toHaveCount(2);

  await tabTo('Adicionar tempo ao slide 1');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Tempo do slide 1, em segundos')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('occurrence').first().getByTestId('timer')).toHaveAttribute('data-duration-ms', '8000');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.getByRole('button', { name: '▶ Apresentar' }).focus();
  await page.keyboard.press('Enter');
  const operator = page.getByTestId('operator');
  await expect(operator).toHaveAttribute('data-status', 'ready');
  // Em notebook de 768 px de altura, os comandos do culto estão na tela sem rolar.
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const name of ['▶ Iniciar', 'Avançar →', '← Voltar', 'Tela preta']) await expect(page.getByTestId('operator-controls').getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  // Atalhos do operador: avançar e voltar sem foco em campo de edição.
  await page.locator('body').press('ArrowRight');
  await expect(operator).toHaveAttribute('data-index', '1');
  await page.locator('body').press('ArrowLeft');
  await expect(operator).toHaveAttribute('data-index', '0');

  // Modo interativo: Tab revela os controles, Enter abre o menu, Esc fecha e devolve o foco.
  await page.getByRole('button', { name: 'Modo interativo' }).focus();
  await page.keyboard.press('Enter');
  const stage = page.getByTestId('interactive-stage');
  await expect(stage).toBeVisible();
  await page.getByTestId('corner-menu').focus();
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
  expect((await focused())?.indicator).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('live-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('live-menu')).toBeHidden();
  await expect(page.getByTestId('corner-menu')).toBeFocused();

  await context.close();
  expect(appErrors()).toEqual([]);
});
