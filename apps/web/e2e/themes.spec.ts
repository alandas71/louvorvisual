import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BrowserProfile, ORIGIN, ProductionServer } from './helpers';
import { createSong, drawn, expectConfirmed, openOperator, openProjection } from './presentation.helpers';

const EVIDENCE = join(__dirname, '..', '..', '..', 'execucao', 'etapas', '15-evidencias');
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

test('AT-26: personalizar uma cópia de tema, recusas de fundo claro e contraste baixo, aplicar ao louvor e trocar de tema sem rede', async () => {
  test.setTimeout(120_000);
  let context = await profile.open();
  let page = await context.newPage();
  // Uma ação que não encontra o alvo falha logo, com o nome do alvo.
  page.setDefaultTimeout(15_000);
  await createSong(page, { durations: [null, null], install: true });
  // Fonte escolhida à mão: precisa permanecer em todas as trocas de tema.
  await page.getByLabel('Fonte', { exact: true }).selectOption({ label: 'Lato' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await context.close();
  await server.stop();

  // Tudo a seguir acontece sem rede e com o servidor fora do ar.
  context = await profile.open({ offline: true });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${ORIGIN}/app?view=temas`);
  const custom = page.getByTestId('custom-themes');
  await expect(custom.getByText('Nenhum tema personalizado ainda.')).toBeVisible();
  await custom.getByLabel('Copiar de').selectOption({ label: 'Violeta' });
  await custom.getByRole('button', { name: 'Duplicar tema' }).click();
  const form = page.getByTestId('custom-theme-form');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Nome do tema')).toHaveValue('Violeta (cópia)');
  await expect(form.getByLabel('Cor do fundo', { exact: true })).toHaveValue('#1B1033');
  await expect(form.getByLabel('Cor da letra', { exact: true })).toHaveValue('#EDE9FE');
  const save = form.getByRole('button', { name: 'Salvar tema' });
  const issues = () => form.getByTestId('custom-theme-issues').locator('li').evaluateAll((items) => items.map((item) => item.getAttribute('data-issue')));

  // Fundo claro é recusado, com o motivo escrito (não só a cor).
  await form.getByLabel('Cor do fundo', { exact: true }).fill('#FFFFFF');
  await form.getByLabel('Cor da letra', { exact: true }).fill('#000000');
  expect(await issues()).toEqual(['background-not-dark']);
  await expect(form.getByText('O fundo está claro demais.', { exact: false })).toBeVisible();
  await expect(save).toBeDisabled();
  // Contraste baixo é recusado.
  await form.getByLabel('Cor do fundo', { exact: true }).fill('#111827');
  await form.getByLabel('Cor da letra', { exact: true }).fill('#4B5563');
  expect(await issues()).toEqual(['low-contrast']);
  await expect(save).toBeDisabled();
  // Cor fora do formato também.
  await form.getByLabel('Cor da letra', { exact: true }).fill('amarelo');
  expect(await issues()).toEqual(['invalid-color']);
  await expect(save).toBeDisabled();
  // Não existe campo de imagem de fundo: o tema é sempre cor sólida.
  await expect(form.locator('input[type="file"], input[type="url"]')).toHaveCount(0);
  await expect(form.getByLabel(/imagem/i)).toHaveCount(0);

  // Paleta escura com contraste: aceita. Tipografia, alinhamento, margens e sombra na mesma cópia.
  await form.getByLabel('Nome do tema').fill('Culto da noite');
  await form.getByLabel('Cor do fundo', { exact: true }).fill('#101010');
  await form.getByLabel('Cor da letra', { exact: true }).fill('#FFE9A8');
  await form.getByLabel('Alinhamento').selectOption({ label: 'À esquerda' });
  await form.getByLabel('Margem lateral (%)').fill('12');
  await form.getByLabel('Sombra da letra').selectOption({ label: 'Sombra suave' });
  await expect(form.getByTestId('custom-theme-issues')).toHaveCount(0);
  await expect(form.getByTestId('custom-theme-contrast')).toContainText(':1');
  await save.click();
  await expect(page.getByTestId('custom-theme-message')).toContainText('"Culto da noite" salvo neste dispositivo.');
  await expect(page.getByTestId('custom-theme')).toHaveCount(1);
  // O tema de fábrica não mudou.
  const violeta = page.getByRole('button', { name: /^Violeta/ }).first();
  expect(await violeta.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe('rgb(27, 16, 51)');
  await page.screenshot({ path: join(EVIDENCE, 'tema-personalizado.png'), fullPage: true });

  // Fecha tudo e reabre sem rede: o tema continua lá e pode ser aplicado ao louvor.
  await context.close();
  context = await profile.open({ offline: true });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${ORIGIN}/app`);
  await page.getByRole('link', { name: /Em União/ }).first().click();
  const theme = page.getByLabel('Tema escuro');
  await theme.selectOption({ label: 'Culto da noite' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await expect(theme.locator('option:checked')).toHaveText('Culto da noite');
  await expect(page.getByLabel('Fonte', { exact: true }).locator('option:checked')).toHaveText('Lato');

  await openOperator(page);
  const projection = await openProjection(context, page);
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expectConfirmed(page, projection);
  // Fundo e letra chegam juntos à saída pública; a fonte manual permanece.
  expect(await drawn(projection)).toMatchObject({ background: 'rgb(16, 16, 16)', color: 'rgb(255, 233, 168)', family: 'Lato', align: 'left' });
  await projection.screenshot({ path: join(EVIDENCE, 'tema-personalizado-na-projecao.png') });
  await page.getByRole('button', { name: 'Encerrar' }).click();
  // A janela pública é reaproveitada pelo nome; fechada, a próxima apresentação abre outra.
  await projection.close();

  // Trocar para um tema de fábrica aplica o par dele por inteiro; a fonte manual continua.
  await page.getByLabel('Tema escuro').selectOption({ label: 'Âmbar' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await openOperator(page);
  const second = await openProjection(context, page);
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expectConfirmed(page, second);
  expect(await drawn(second)).toMatchObject({ background: 'rgb(33, 24, 9)', color: 'rgb(253, 230, 138)', family: 'Lato', align: 'center' });
  await page.getByRole('button', { name: 'Encerrar' }).click();
  await second.close();

  // Excluir o tema personalizado não desfaz o louvor que guardou a cópia dele.
  await page.getByLabel('Tema escuro').selectOption({ label: 'Culto da noite' });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await page.goto(`${ORIGIN}/app?view=temas`);
  await page.getByTestId('custom-theme').click();
  await page.getByRole('button', { name: 'Excluir tema…' }).click();
  await page.getByRole('button', { name: 'Excluir tema', exact: true }).click();
  await expect(page.getByTestId('custom-theme')).toHaveCount(0);
  await page.goto(`${ORIGIN}/app`);
  await page.getByRole('link', { name: /Em União/ }).first().click();
  await expect(page.getByLabel('Tema escuro').locator('option:checked')).toHaveText('Personalizado (cópia guardada neste louvor)');
  await openOperator(page);
  const third = await openProjection(context, page);
  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expectConfirmed(page, third);
  expect(await drawn(third)).toMatchObject({ background: 'rgb(16, 16, 16)', color: 'rgb(255, 233, 168)', family: 'Lato' });

  await context.close();
  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});
