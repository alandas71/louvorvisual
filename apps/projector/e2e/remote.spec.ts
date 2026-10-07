import { expect, test } from '@playwright/test';
import { commands, expectFocus, focusState, inputStats, KEY, moveTo, open, prepareFromSetlist, press, requested, slideIndex, stage, startFromSetlist, watch } from './helpers';

// Toda a navegação destes testes é feita pelo teclado, que o host simulado
// entrega como as teclas do controle: cima, baixo, esquerda, direita, OK e
// Voltar. Nenhum clique de ponteiro.

test('fluxo completo só com o controle: abrir repertório, iniciar, passar slides, ajustar e encerrar', async ({ page }) => {
  const seen = watch(page);
  await open(page);

  // Início: quatro cartões grandes, percorridos nas quatro direções.
  await press(page, 'right');
  await expectFocus(page, 'card-songs', 'home');
  await press(page, 'down');
  await expectFocus(page, 'card-settings', 'home');
  await press(page, 'left');
  await expectFocus(page, 'card-import', 'home');
  await press(page, 'up');
  await expectFocus(page, 'card-setlists', 'home');
  const card = await page.getByTestId('card-setlists').boundingBox();
  expect(card!.width).toBeGreaterThan(700);
  expect(card!.height).toBeGreaterThan(300);

  // Repertório → louvor → pergunta de início. Nada começa sozinho.
  await prepareFromSetlist(page);
  await expect(page.getByTestId('ready-dialog')).toContainText('Em União');
  await expect(stage(page)).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('[data-slide-frame]')).toHaveAttribute('data-visual-mode', 'black');
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');
  await expectFocus(page, 'slide-focus', 'slide');
  await expect(page.locator('[data-slide-text]')).toHaveText(/Com esperança eu vou caminhar/);

  // Apresentação limpa: esquerda e direita trocam um slide por toque e não revelam nada.
  await press(page, 'right');
  expect(await slideIndex(page)).toBe(1);
  await expect(page.locator('[data-slide-text]')).toHaveText(/Hoje cantamos em união/);
  await press(page, 'left');
  expect(await slideIndex(page)).toBe(0);
  await expect(page.getByTestId('quick-controls')).toHaveCount(0);
  await expect(page.getByTestId('menu')).toHaveCount(0);
  // No primeiro slide a ocorrência é mantida.
  await press(page, 'left');
  expect(await slideIndex(page)).toBe(0);
  await expect(page.getByTestId('stage-toast')).toHaveText('Primeiro slide');

  // OK abre o menu com foco no primeiro item; ali as setas navegam, não trocam slide.
  await press(page, 'ok');
  await expectFocus(page, 'menu-item-tema', 'menu');
  await press(page, 'right', 'left');
  expect(await slideIndex(page)).toBe(0);
  await press(page, 'ok');
  await expectFocus(page, 'theme-grafite', 'menu-tema');
  await press(page, 'right');
  await expectFocus(page, 'theme-azul-noturno', 'menu-tema');
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-theme', 'azul-noturno');
  await expect(page.locator('[data-slide-composition]')).toHaveCSS('background-color', 'rgb(11, 23, 48)');
  // Voltar fecha o submenu e devolve o foco ao item que o abriu.
  await press(page, 'back');
  await expectFocus(page, 'menu-item-tema', 'menu');

  // Campo de ajuste: esquerda e direita mudam o valor, sem digitação e sem trocar slide.
  await press(page, 'down', 'down', 'ok');
  await expectFocus(page, 'size-adjust', 'menu-tamanho');
  await press(page, 'right', 'right');
  await expect(stage(page)).toHaveAttribute('data-font-size', '104');
  await press(page, 'left');
  await expect(stage(page)).toHaveAttribute('data-font-size', '100');
  expect(await slideIndex(page)).toBe(0);
  await press(page, 'back');
  await expectFocus(page, 'menu-item-tamanho', 'menu');

  // Voltar fecha o menu antes de qualquer pergunta de encerramento.
  await press(page, 'back');
  await expect(stage(page)).toHaveAttribute('data-overlay', 'none');
  await expectFocus(page, 'slide-focus', 'slide');
  await expect(page.getByTestId('exit-dialog')).toHaveCount(0);

  // Só então Voltar oferece encerrar, com o padrão em continuar; Voltar de novo continua.
  await press(page, 'back');
  await expectFocus(page, 'exit-continue', 'exit');
  await press(page, 'back');
  await expectFocus(page, 'slide-focus', 'slide');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');

  // Cima mostra os controles rápidos com um botão em foco. Sem tempo nem áudio não há play/pause nem relógio.
  await press(page, 'up');
  await expectFocus(page, 'control-larger', 'controls');
  await expect(page.getByTestId('control-transport')).toHaveCount(0);
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  await expect(page.getByTestId('control-larger').locator('.control-label')).toBeVisible();
  await expect(page.getByTestId('control-next').locator('.control-label')).toBeHidden();
  const target = await page.getByTestId('control-larger').boundingBox();
  expect(Math.min(target!.width, target!.height)).toBeGreaterThanOrEqual(64);
  await press(page, 'right');
  await expectFocus(page, 'control-next', 'controls');
  await press(page, 'ok');
  expect(await slideIndex(page)).toBe(1);
  // Girar a letra não gira os controles.
  await press(page, 'up');
  await expectFocus(page, 'control-rotate', 'controls');
  const before = await page.getByTestId('control-rotate').boundingBox();
  await press(page, 'ok');
  await expect(page.locator('[data-slide-frame]')).toHaveAttribute('data-rotation', '90');
  expect(await page.getByTestId('control-rotate').boundingBox()).toEqual(before);
  await expect(page.getByTestId('control-rotate')).toHaveCSS('transform', 'none');
  // Os controles ficam enquanto há foco neles (mais que os 3 s de inatividade da web).
  await page.waitForTimeout(3500);
  await expectFocus(page, 'control-rotate', 'controls');

  // Voltar fecha os controles; Voltar de novo pergunta; Encerrar volta ao repertório, no mesmo louvor.
  await press(page, 'back');
  await expectFocus(page, 'slide-focus', 'slide');
  await press(page, 'back', 'down');
  await expectFocus(page, 'exit-end', 'exit');
  const sessionCommands = await commands(page);
  await press(page, 'ok');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'setlist');
  await expectFocus(page, /^item:/, 'setlist');
  await expect(page.locator('[data-focusable]:focus .row-title')).toHaveText('Em União');

  // Um comando por toque, nada repetido.
  expect(sessionCommands).toEqual(['start', 'next', 'previous', 'previous!at-limit', 'adjust', 'stepFontSize', 'stepFontSize', 'stepFontSize', 'next', 'rotate']);
  expect(await inputStats(page)).toMatchObject({ duplicate: 0, repeat: 0 });
  // Sessão encerrada no host, tela liberada, rotação guardada no aparelho.
  expect(await page.evaluate(() => window.__lvMock.keepAwake)).toBe(false);
  expect(await page.evaluate(() => window.__lvMock.requests.filter((request) => request.method === 'session.end').length)).toBe(1);
  expect(await page.evaluate(() => window.__lvMock.requests.filter((request) => request.method === 'prefs.set').map((request) => request.params))).toEqual([{ prefs: { recentSetlistId: expect.any(String) } }, { prefs: { rotation: 90 } }]);
  expect(seen.errors).toEqual([]);
});

test('tecla mantida não pula slides, não percorre controles recém-abertos e não ativa duas vezes', async ({ page }) => {
  await open(page);
  await startFromSetlist(page);

  // → mantida: o teclado repete, o slide avança uma vez.
  for (let repeat = 0; repeat < 12; repeat += 1) await page.keyboard.down(KEY.right);
  expect(await slideIndex(page)).toBe(1);
  await page.keyboard.up(KEY.right);
  expect(await slideIndex(page)).toBe(1);
  // Solta e aperta: volta a valer.
  await press(page, 'right');
  expect(await slideIndex(page)).toBe(2);
  expect(await commands(page)).toEqual(['start', 'next', 'next']);
  expect((await inputStats(page)).repeat).toBe(11);

  // OK mantido: abre o menu uma vez e não "entra" no primeiro item.
  for (let repeat = 0; repeat < 8; repeat += 1) await page.keyboard.down(KEY.ok);
  await page.keyboard.up(KEY.ok);
  await expectFocus(page, 'menu-item-tema', 'menu');
  await expect(page.getByTestId('menu-tema')).toHaveCount(0);

  // Voltar mantido: fecha o menu e para aí — não chega à pergunta de encerramento.
  for (let repeat = 0; repeat < 8; repeat += 1) await page.keyboard.down(KEY.back);
  await page.keyboard.up(KEY.back);
  await expectFocus(page, 'slide-focus', 'slide');
  await expect(page.getByTestId('exit-dialog')).toHaveCount(0);

  // ↓ mantida: mostra os controles e o foco fica no primeiro, sem sair andando.
  for (let repeat = 0; repeat < 8; repeat += 1) {
    await page.keyboard.down(KEY.down);
    await page.waitForTimeout(100);
  }
  await page.keyboard.up(KEY.down);
  await expectFocus(page, 'control-larger', 'controls');
  expect((await inputStats(page))['held-across-contexts']).toBe(7);

  // OK mantido sobre "Próximo slide": um avanço.
  await press(page, 'right');
  await expectFocus(page, 'control-next', 'controls');
  for (let repeat = 0; repeat < 8; repeat += 1) await page.keyboard.down(KEY.ok);
  await page.keyboard.up(KEY.ok);
  expect(await slideIndex(page)).toBe(3);
  expect(await commands(page)).toEqual(['start', 'next', 'next', 'next']);
});

test('mensagens repetidas ou malformadas da ponte não viram comandos', async ({ page }) => {
  await open(page);
  await startFromSetlist(page);
  const before = (await inputStats(page)).duplicate;

  // A mesma mensagem (mesma sequência) entregue três vezes: um avanço.
  await page.evaluate(() => {
    const seq = window.__lvMock.key('right', 'down', 0);
    window.__lvMock.key('right', 'down', 0, seq);
    window.__lvMock.key('right', 'down', 0, seq);
    window.__lvMock.key('right', 'up', 0);
    // Reentrega atrasada do `down`, depois do `up`.
    window.__lvMock.key('right', 'down', 0, seq);
  });
  expect(await slideIndex(page)).toBe(1);
  expect(((await inputStats(page)).duplicate ?? 0) - (before ?? 0)).toBe(3);

  // Host que manda `down` duas vezes sem `up` (repeat 0 nas duas): um avanço.
  await page.evaluate(() => {
    window.__lvMock.key('right', 'down', 0);
    window.__lvMock.key('right', 'down', 0);
    window.__lvMock.key('right', 'up', 0);
  });
  expect(await slideIndex(page)).toBe(2);

  // Lixo na ponte: texto qualquer, evento desconhecido, tecla que não existe, resposta sem pedido.
  await page.evaluate(() => {
    window.__lvMock.raw('isto não é JSON');
    window.__lvMock.raw(JSON.stringify({ v: 1, kind: 'event', event: 'remote.key', payload: { epoch: 'x', seq: 999999, key: 'home', action: 'down', repeat: 0 } }));
    window.__lvMock.raw(JSON.stringify({ v: 1, kind: 'event', event: 'remote.exec', payload: { code: 'alert(1)' } }));
    window.__lvMock.raw(JSON.stringify({ v: 2, kind: 'event', event: 'remote.key', payload: { epoch: 'x', seq: 1, key: 'right', action: 'down', repeat: 0 } }));
    window.__lvMock.raw(JSON.stringify({ v: 1, kind: 'response', id: 424242, ok: true, result: {} }));
  });
  expect(await slideIndex(page)).toBe(2);
  // E a entrada continua funcionando depois disso.
  await press(page, 'left');
  expect(await slideIndex(page)).toBe(1);
  expect(await commands(page)).toEqual(['start', 'next', 'next', 'previous']);

  // Duas teclas diferentes no mesmo instante: cada uma age no contexto que a anterior deixou.
  await page.evaluate(() => {
    window.__lvMock.press('ok');
    window.__lvMock.press('down');
  });
  await expectFocus(page, 'menu-item-fonte', 'menu');
  await expect(page.getByTestId('quick-controls')).toHaveCount(0);
});

test('em listas a seta mantida percorre e carrega as páginas seguintes; OK mantido abre uma tela só', async ({ page }) => {
  await open(page);
  // OK mantido no cartão: abre os repertórios e para — não abre também o primeiro repertório.
  for (let repeat = 0; repeat < 10; repeat += 1) await page.keyboard.down(KEY.ok);
  await page.keyboard.up(KEY.ok);
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'setlists');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'setlists');
  await press(page, 'back');
  await expectFocus(page, 'card-setlists', 'home');

  await press(page, 'right', 'ok');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'songs');
  await expectFocus(page, /^song:/, 'songs');
  await expect(page.locator('[data-testid=song-list] .row')).toHaveCount(20);
  expect(await requested(page, 'library.listSongs')).toBe(1);

  // ↓ mantida: o foco desce vários itens, a lista rola junto e as páginas seguintes chegam.
  const first = await focusState(page);
  for (let repeat = 0; repeat < 45; repeat += 1) {
    await page.keyboard.down(KEY.down);
    await page.waitForTimeout(100);
  }
  await page.keyboard.up(KEY.down);
  const last = await focusState(page);
  expect(last.id).not.toBe(first.id);
  expect(last).toMatchObject({ layer: 'songs', visible: true });
  await expect(page.locator('[data-testid=song-list] .row')).toHaveCount(40);
  await expect(page.getByTestId('songs-count')).toHaveText('40 neste aparelho');
  expect(await requested(page, 'library.listSongs')).toBe(2);
  // O item em foco está dentro da área visível da lista.
  const list = await page.getByTestId('song-list').boundingBox();
  const row = await page.locator('[data-focusable]:focus').boundingBox();
  expect(row!.y).toBeGreaterThanOrEqual(list!.y - 1);
  expect(row!.y + row!.height).toBeLessThanOrEqual(list!.y + list!.height + 1);
  // Chegou ao fim: mais ↓ não tira o foco de lá.
  await press(page, 'down', 'down');
  expect((await focusState(page)).id).toBe(last.id);
  // Esquerda e direita não saltam entre itens de uma lista vertical.
  await press(page, 'left', 'right');
  expect((await focusState(page)).id).toBe(last.id);
});

test('contexto de foco: automático com tempo, botão condicional que some, teclas Menu e play/pause', async ({ page }) => {
  await open(page);
  // "Manhã de Gratidão": automático; slides 1 e 3 com 4 s, slide 2 sem tempo.
  await prepareFromSetlist(page, 1);
  await expect(page.getByTestId('ready-facts')).toContainText('avanço automático');
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');

  // Com tempo no slide atual, os controles abrem no play/pause e mostram a contagem.
  await press(page, 'down');
  await expectFocus(page, 'control-transport', 'controls');
  await expect(page.getByTestId('timer-indicator')).toHaveAttribute('data-counting', 'true');
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('control-transport')).toHaveAttribute('aria-label', 'Tocar');
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');

  // O slide vence sozinho e o seguinte não tem tempo: play/pause e relógio somem
  // com o foco em cima deles. O foco vai para o vizinho válido, nunca para o nada.
  await expect(stage(page)).toHaveAttribute('data-slide-index', '1', { timeout: 8000 });
  await expect(page.getByTestId('control-transport')).toHaveCount(0);
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);
  const moved = await focusState(page);
  expect(moved).toMatchObject({ layer: 'controls', visible: true });
  expect(['control-larger', 'control-next']).toContain(moved.id);

  // A tecla Menu troca dos controles para o menu; nele, alterna: fecha tudo de qualquer nível.
  await press(page, 'menu');
  await expectFocus(page, 'menu-item-tema', 'menu');
  await expect(page.getByTestId('quick-controls')).toHaveCount(0);
  await expect(page.getByTestId('menu-mode')).toContainText('Automático · esperando você');
  await press(page, 'down', 'down', 'down', 'ok');
  await expectFocus(page, 'timer-adjust', 'menu-tempo');
  await press(page, 'menu');
  await expectFocus(page, 'slide-focus', 'slide');
  await expect(stage(page)).toHaveAttribute('data-overlay', 'none');

  // Slide sem tempo e sem áudio: a tecla play/pause não faz nada (nem erro, nem comando).
  const before = await commands(page);
  await press(page, 'playPause');
  expect(await commands(page)).toEqual(before);
  await expect(page.getByTestId('stage-toast')).toHaveCount(0);

  // Temporizador sem digitação: ←/→ ajustam, Aplicar grava, e a contagem volta.
  await press(page, 'ok', 'down', 'down', 'down', 'ok');
  await expectFocus(page, 'timer-adjust', 'menu-tempo');
  await expect(page.getByTestId('timer-adjust')).toContainText('8,0 s');
  await press(page, 'left', 'left', 'left', 'left');
  await expect(page.getByTestId('timer-adjust')).toContainText('6,0 s');
  await press(page, 'down');
  await expectFocus(page, 'timer-apply', 'menu-tempo');
  await press(page, 'ok');
  await expect(page.getByTestId('menu-tempo')).toContainText('Remover tempo');
  await press(page, 'menu');
  await expectFocus(page, 'slide-focus', 'slide');
  // Agora há tempo: play/pause do controle pausa e retoma.
  await press(page, 'playPause');
  await expect(stage(page)).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('stage-status')).toContainText('Em pausa');
  await press(page, 'playPause');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');
  expect((await commands(page)).slice(before.length)).toEqual(['setDuration', 'toggle', 'toggle']);

  // Em nenhum momento sobrou um botão de camada fechada na tela.
  await expect(page.locator('[data-layer=menu], [data-layer=controls], [data-layer=exit]')).toHaveCount(0);
});

test('áudio pelo player do host: transporte, volume, pausa vinda de fora e faixa ausente', async ({ page }) => {
  await open(page);
  // "Canção da Colheita": manual, com playback independente.
  await prepareFromSetlist(page, 2);
  await expect(page.getByTestId('ready-facts')).toContainText('playback independente');
  await press(page, 'ok');
  expect(await page.evaluate(() => window.__lvMock.audio())).toMatchObject({ loaded: true, playing: false });

  // Faixa pronta mantém o play/pause mesmo em slide sem tempo.
  await press(page, 'playPause');
  await expect.poll(() => page.evaluate(() => window.__lvMock.audio().playing)).toBe(true);
  await press(page, 'up');
  await expectFocus(page, 'control-transport', 'controls');
  await expect(page.getByTestId('control-transport')).toHaveAttribute('aria-label', 'Pausar');
  await expect(page.getByTestId('timer-indicator')).toHaveCount(0);

  // Trocar de slide não mexe na faixa independente.
  await press(page, 'back', 'right');
  expect(await slideIndex(page)).toBe(1);
  expect(await page.evaluate(() => window.__lvMock.audio().playing)).toBe(true);

  // Pausa de fora do aplicativo aparece na interface.
  await page.evaluate(() => window.__lvMock.interruptAudio());
  await press(page, 'up');
  await expect(page.getByTestId('control-transport')).toHaveAttribute('aria-label', 'Tocar');
  await press(page, 'back');

  // Volume pelo menu, com as setas.
  await press(page, 'ok');
  await page.getByTestId('menu-item-audio').waitFor();
  await moveTo(page, 'menu-item-audio');
  await press(page, 'ok', 'down');
  await expectFocus(page, 'audio-volume', 'menu-audio');
  await press(page, 'left', 'left');
  await expect(page.getByTestId('audio-volume')).toContainText('70 %');
  expect(await page.evaluate(() => window.__lvMock.audio().volume)).toBeCloseTo(0.7, 5);
  // O menu projetado diz o tipo da faixa, não o nome do arquivo.
  await expect(page.getByTestId('menu-audio')).toContainText('Playback · independente');
  await expect(page.locator('body')).not.toContainText('playback-colheita.mp3');

  // Encerrar solta o player do host.
  await press(page, 'menu', 'back', 'down', 'ok');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'setlist');
  expect(await page.evaluate(() => window.__lvMock.audio())).toMatchObject({ loaded: false, playing: false });

  // "Luz no Caminho": a faixa não está no aparelho; a tela avisa e apresenta sem áudio.
  await press(page, 'down', 'ok');
  await expect(page.getByTestId('ready-audio-missing')).toBeVisible();
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-status', 'running');
  await press(page, 'up');
  await expect(page.getByTestId('control-transport')).toHaveCount(0);
});

test('próximo louvor é uma ação explícita do menu; no último slide a apresentação não troca de louvor sozinha', async ({ page }) => {
  await open(page);
  await startFromSetlist(page);
  await press(page, 'right', 'right', 'right', 'right', 'right');
  expect(await slideIndex(page)).toBe(3);
  await expect(page.getByTestId('stage-toast')).toHaveText('Último slide');
  await expect(page.locator('[data-slide-text]')).toHaveText(/Hoje cantamos em união/);

  await press(page, 'ok');
  await expect(page.getByTestId('menu-next-song')).toContainText('Manhã de Gratidão');
  await expect(page.getByTestId('menu-previous-song')).toHaveCount(0);
  // Sem ajuste feito, "Desfazer" e "Restaurar" estão desabilitados e o foco passa direto por eles.
  await expect(page.getByTestId('menu-undo')).toBeDisabled();
  await moveTo(page, 'menu-next-song');
  await expect(page.locator('[data-layer=menu] [data-focusable]:disabled:focus')).toHaveCount(0);
  await press(page, 'ok');
  // O louvor seguinte é preparado e espera o operador.
  await expectFocus(page, 'ready-start', 'ready');
  await expect(page.getByTestId('ready-dialog')).toContainText('Manhã de Gratidão');
  await expect(stage(page)).toHaveAttribute('data-status', 'ready');
  // Voltar daqui retorna ao repertório, com o foco no louvor que estava preparado.
  await press(page, 'back');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'setlist');
  await expect(page.locator('[data-focusable]:focus .row-title')).toHaveText('Manhã de Gratidão');
});
