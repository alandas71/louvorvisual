import { expect, test } from '@playwright/test';
import { expectFocus, focusState, open, press, requested, slideIndex, stage, startFromSetlist, watch } from './helpers';

test('bundle embarcável: tudo vem de /assets/, sem rede, sem armazenamento do navegador, sem host simulado fora de teste', async ({ page, baseURL }) => {
  const seen = watch(page);
  await open(page);
  await startFromSetlist(page);
  // Passa por todas as oito famílias de fonte, para o navegador buscar cada arquivo.
  await press(page, 'ok', 'down', 'ok');
  await expectFocus(page, 'font-inter', 'menu-fonte');
  const fonts = ['inter', 'roboto', 'open-sans', 'montserrat', 'lato', 'noto-sans', 'source-sans-3', 'atkinson-hyperlegible'];
  const families = ['Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Noto Sans', 'Source Sans 3', 'Atkinson Hyperlegible'];
  for (const [index, font] of fonts.entries()) {
    await expectFocus(page, `font-${font}`, 'menu-fonte');
    await press(page, 'ok');
    // A letra é desenhada com a face do pacote (família e peso exatos), não com uma reserva do sistema.
    await expect
      .poll(() => page.evaluate((family) => [...document.fonts].some((face) => face.family.replace(/["']/g, '') === family && face.weight === '700' && face.status === 'loaded'), families[index]!))
      .toBe(true);
    await expect(page.locator('[data-slide-composition] > div')).toHaveCSS('font-family', new RegExp(`^"?${families[index]}"?,`));
    await press(page, index % 2 === 0 ? 'right' : 'left');
    if (index % 2 === 1) await press(page, 'down', index === fonts.length - 1 ? 'up' : 'left');
  }

  // Todo pedido da página foi para o próprio bundle.
  const prefix = `${baseURL}/assets/`;
  expect(seen.requests.length).toBeGreaterThan(10);
  expect(seen.requests.filter((url) => !url.startsWith(prefix))).toEqual([]);
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
  const requestedFonts = seen.requests.filter((url) => url.includes('/fonts/'));
  expect(new Set(requestedFonts).size).toBeGreaterThanOrEqual(8);
  expect(requestedFonts.every((url) => /\/assets\/fonts\/v1\/[a-z0-9-]+\.woff2$/.test(url))).toBe(true);
  // CSS e chunks: todos de /assets/_next/.
  const assets = seen.requests.filter((url) => /\.(js|css)(\?|$)/.test(url));
  expect(assets.length).toBeGreaterThan(5);
  expect(assets.every((url) => url.startsWith(`${prefix}_next/static/`))).toBe(true);

  // Nada do bundle usa o armazenamento do navegador (o WebView do host nem o oferece).
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    cookies: document.cookie,
    // Só o host simulado guarda estado, e na sessão do navegador de teste.
    session: Object.keys(sessionStorage),
  }));
  expect(storage).toEqual({ local: 0, databases: 0, caches: 0, workers: 0, cookies: '', session: ['lv-mock-host'] });
});

test('sem host e sem pedir o simulado, o bundle não finge funcionar nem carrega o host simulado', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/assets/index.html');
  await expect(page.getByTestId('host-unavailable')).toContainText('faz parte do aplicativo LouvorVisual do projetor');
  expect(await page.evaluate(() => 'lv-mock-host' in sessionStorage || '__lvMock' in window)).toBe(false);
  const scripts = seen.requests.filter((url) => url.endsWith('.js'));
  for (const url of scripts) expect(await (await page.request.get(url)).text()).not.toContain('lv-mock-host');
});

test('nada privado no menu projetado: sem notas, conta, sincronização ou nome de arquivo durante a apresentação', async ({ page }) => {
  await open(page);
  // Entra na equipe primeiro, para existir dado de conta que poderia vazar.
  await press(page, 'right', 'down', 'ok');
  await expectFocus(page, 'settings-signin', 'settings');
  await press(page, 'ok');
  await expect(page.getByTestId('account-summary')).toContainText('Equipe de Louvor (demonstração)');
  await press(page, 'back');
  await expectFocus(page, 'card-settings', 'home');
  await press(page, 'up', 'left');
  await expectFocus(page, 'card-setlists', 'home');

  const forbidden = /NOTA-PRIVADA|Equipe de Louvor|[Ss]incroniza|playback-.*\.mp3|@|[Ss]enha|[Tt]oken/;
  const everything = () => page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[aria-label],[title]')].map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`).join(' '));
  const check = async (where: string) => expect(await everything(), where).not.toMatch(forbidden);

  // Listas e pergunta de início: as notas do repertório e dos itens não aparecem.
  await press(page, 'ok');
  await expectFocus(page, /^setlist:/, 'setlists');
  await check('lista de repertórios');
  await press(page, 'ok');
  await expectFocus(page, /^item:/, 'setlist');
  await check('repertório');
  await press(page, 'down', 'down', 'ok');
  await expectFocus(page, 'ready-start', 'ready');
  await check('pergunta de início');
  await press(page, 'ok');
  await check('slide limpo');
  await press(page, 'up');
  await expectFocus(page, 'control-transport', 'controls');
  await check('controles rápidos');
  await press(page, 'menu');
  await expectFocus(page, 'menu-item-tema', 'menu');
  await check('menu');

  // Cada submenu, aberto e conferido.
  const items = await page.locator('[data-layer=menu] [data-testid^=menu-item-]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid') as string));
  expect(items).toEqual(['menu-item-tema', 'menu-item-fonte', 'menu-item-tamanho', 'menu-item-tempo', 'menu-item-alinhamento', 'menu-item-audio', 'menu-item-saida']);
  for (const id of items) {
    for (let guard = 0; guard < 20 && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) !== id; guard += 1) await press(page, 'down');
    await expectFocus(page, id, 'menu');
    await press(page, 'ok');
    await expect(page.locator(`[data-layer=${id.replace('menu-item-', 'menu-')}]`)).toBeVisible();
    await check(id);
    await press(page, 'back');
    await expectFocus(page, id, 'menu');
  }

  // A sessão guardada no host não leva as notas do louvor.
  const stored = await page.evaluate(() => JSON.stringify(window.__lvMock.requests.filter((request) => request.method.startsWith('session.'))));
  expect(stored).toContain('Canção da Colheita');
  expect(stored).not.toContain('NOTA-PRIVADA');
  // E nenhum pedido à ponte saiu do contrato.
  const methods = await page.evaluate(() => [...new Set(window.__lvMock.requests.map((request) => request.method))]);
  expect(methods.every((method) => /^(host|prefs|library|session|files|audio|account)\.[A-Za-z]+$/.test(method))).toBe(true);
});

test('fechar no meio do culto: ao reabrir, a sessão é oferecida e volta em pausa, sem tocar nada', async ({ page }) => {
  await open(page);
  // Louvor com playback, tocando, no terceiro slide, com a letra aumentada.
  await startFromSetlist(page, 2);
  await press(page, 'right', 'right', 'playPause');
  await expect.poll(() => page.evaluate(() => window.__lvMock.audio().playing)).toBe(true);
  await press(page, 'up', 'left', 'ok');
  await expect(stage(page)).toHaveAttribute('data-font-size', '100');
  await expect.poll(() => page.evaluate(() => window.__lvSession.getSnapshot().checkpoint)).toBe('saved');

  // O aplicativo é fechado sem encerrar (aqui: a página é recarregada; o host guardou o checkpoint).
  await page.reload();
  await expectFocus(page, 'recover-resume', 'recover');
  await expect(page.getByTestId('recover-dialog')).toContainText('Canção da Colheita');
  expect(await page.evaluate(() => window.__lvMock.audio())).toMatchObject({ loaded: false, playing: false });
  // Voltar só fecha a pergunta; a sessão continua oferecida em um cartão.
  await press(page, 'back');
  await expectFocus(page, 'card-setlists', 'home');
  await press(page, 'up');
  await expectFocus(page, 'card-recover', 'home');
  await press(page, 'ok', 'ok');

  await expect(stage(page)).toHaveAttribute('data-status', 'paused');
  expect(await slideIndex(page)).toBe(2);
  await expect(stage(page)).toHaveAttribute('data-font-size', '100');
  await expect(page.getByTestId('stage-toast')).toHaveText('Sessão recuperada em pausa');
  await expectFocus(page, 'slide-focus', 'slide');
  expect(await page.evaluate(() => window.__lvMock.audio())).toMatchObject({ loaded: true, playing: false });
  // Quem retoma é o operador.
  await press(page, 'playPause');
  await expect.poll(() => page.evaluate(() => window.__lvMock.audio().playing)).toBe(true);

  // Encerrada de verdade, não volta a ser oferecida.
  await press(page, 'back', 'down', 'ok');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'home');
  await expect(page.getByTestId('card-recover')).toHaveCount(0);
  await page.reload();
  await expectFocus(page, 'card-setlists', 'home');
  await expect(page.getByTestId('recover-dialog')).toHaveCount(0);
});

test('sair para o Home do aparelho pausa a apresentação; descartar a sessão interrompida limpa o início', async ({ page }) => {
  await open(page);
  await startFromSetlist(page, 1);
  await expect(stage(page)).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => window.__lvMock.emit('host.lifecycle', { state: 'background' }));
  await expect(stage(page)).toHaveAttribute('data-status', 'paused');
  await page.evaluate(() => window.__lvMock.emit('host.lifecycle', { state: 'foreground' }));
  // Voltar ao primeiro plano não retoma sozinho.
  await page.waitForTimeout(500);
  await expect(stage(page)).toHaveAttribute('data-status', 'paused');
  expect(await requested(page, 'session.saveCheckpoint')).toBeGreaterThan(0);

  await page.reload();
  await expectFocus(page, 'recover-resume', 'recover');
  await press(page, 'down', 'ok');
  await expectFocus(page, 'card-setlists', 'home');
  await expect(page.getByTestId('card-recover')).toHaveCount(0);
  expect(await requested(page, 'session.end')).toBe(1);
});

test('importar pacote e configurações, só com o controle', async ({ page }) => {
  await open(page);
  await press(page, 'down', 'ok');
  await expectFocus(page, 'import-pick', 'import');

  // Pacote adulterado: recusado com motivo, nada importado.
  await page.evaluate(() => (window.__lvMock.nextPick = 'hash-mismatch'));
  await press(page, 'ok');
  await expectFocus(page, 'import-retry', 'import');
  await expect(page.getByTestId('import-rejected')).toContainText('corrompido ou foi alterado');
  // Seletor cancelado.
  await page.evaluate(() => (window.__lvMock.nextPick = 'cancelled'));
  await press(page, 'ok');
  await expect(page.getByTestId('import-note')).toHaveText('Nenhum arquivo foi escolhido.');
  // Pacote íntegro: prévia antes de gravar; Voltar na prévia cancela e descarta a cópia de preparação.
  await page.evaluate(() => (window.__lvMock.nextPick = 'ready'));
  await press(page, 'ok');
  await expectFocus(page, 'import-apply', 'import');
  await expect(page.getByTestId('import-preview')).toContainText('Culto de quarta');
  await expect(page.getByTestId('import-preview')).toContainText('1 faixa de áudio não veio');
  await press(page, 'back');
  await expect(page.getByTestId('import-note')).toHaveText('Importação cancelada. Nada foi gravado.');
  expect(await requested(page, 'files.discardImport')).toBe(1);
  expect(await requested(page, 'files.applyImport')).toBe(0);
  // De novo, agora confirmando.
  await press(page, 'ok');
  await expectFocus(page, 'import-apply', 'import');
  await press(page, 'ok');
  await expectFocus(page, 'import-open', 'import');
  await press(page, 'ok');
  await expect(page.getByTestId('setlist-title')).toHaveText('Culto de quarta');
  await expectFocus(page, /^item:/, 'setlist');
  // Voltar do repertório importado leva ao início (a tela de importação foi substituída).
  await press(page, 'back');
  await expectFocus(page, 'card-import', 'home');

  // Configurações: margem de segurança com ←/→ e rotação, guardadas no aparelho.
  await press(page, 'right', 'ok');
  await expectFocus(page, 'settings-signin', 'settings');
  await press(page, 'right');
  await expectFocus(page, 'settings-safe-area', 'settings');
  await press(page, 'right', 'right', 'right', 'left');
  await expect(page.getByTestId('settings-safe-area')).toContainText('1,0 %');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--safe'))).toBe('1vmin');
  const app = await page.getByTestId('app').boundingBox();
  expect(Math.round(app!.x)).toBe(11);
  await page.reload();
  await expectFocus(page, 'card-setlists', 'home');
  expect(Math.round((await page.getByTestId('app').boundingBox())!.x)).toBe(11);
  await expect(page.getByTestId('recent-setlist')).toHaveText('Escolher um repertório deste aparelho');
});

test('aparelho recém-instalado, sem conteúdo: as telas explicam e o foco está sempre em uma ação possível', async ({ page }) => {
  await open(page, '&mock=empty');
  await press(page, 'ok');
  await expectFocus(page, 'empty-import', 'setlists');
  await expect(page.getByTestId('setlist-list')).toContainText('Nenhum repertório neste aparelho');
  // A ação leva direto à importação; Voltar de lá retorna ao início.
  await press(page, 'ok');
  await expectFocus(page, 'import-pick', 'import');
  await press(page, 'back');
  await expectFocus(page, 'card-setlists', 'home');
  await press(page, 'right', 'ok');
  await expect(page.getByTestId('song-list')).toContainText('Nenhum louvor neste aparelho');
  expect(await focusState(page)).toMatchObject({ layer: 'songs', visible: true });
});

test('o repertório usado por último vem destacado, sem iniciar sozinho', async ({ page }) => {
  await open(page);
  await press(page, 'ok', 'down', 'ok');
  await expect(page.getByTestId('setlist-title')).toHaveText('Ensaio de quinta');
  await press(page, 'ok');
  await expectFocus(page, 'ready-start', 'ready');
  await press(page, 'back', 'back', 'back');
  await expectFocus(page, 'card-setlists', 'home');
  await expect(page.getByTestId('recent-setlist')).toHaveText('Usado por último: Ensaio de quinta');

  await page.reload();
  await expectFocus(page, 'card-setlists', 'home');
  await expect(page.getByTestId('recent-setlist')).toHaveText('Usado por último: Ensaio de quinta');
  // Preparar sem iniciar não deixa sessão para recuperar.
  await expect(page.getByTestId('recover-dialog')).toHaveCount(0);
  // Nenhuma apresentação começou: o início continua no início.
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'home');
  await press(page, 'ok');
  // Ao abrir a lista, o foco já está no repertório usado por último.
  await expect(page.locator('[data-focusable]:focus .row-title')).toHaveText('Ensaio de quinta');
  await expect(page.locator('[data-focusable]:focus .tag')).toHaveText('Usado por último');
});
