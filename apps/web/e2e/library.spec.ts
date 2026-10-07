import { expect, test, type Locator, type Page } from '@playwright/test';
import { BrowserProfile, isReachable, ORIGIN, ProductionServer, waitUntilInstalled } from './helpers';

// Letra original escrita para os testes deste projeto. O último bloco não tem
// marcador de propósito: deve aparecer como sugestão incerta.
const LYRICS = `[Estrofe 1]
Com esperança eu vou caminhar
E com minha voz agradecer

[Refrão]
Hoje cantamos em união
Com alegria no coração

[Refrão]
Hoje cantamos em união
Com alegria no coração

Ó, quão bom é — louvar!`;

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

type StoredOccurrence = { id: string; sourceSectionId: string | null; label: string; text: string; order: number; durationMs: number | null };
type Stored = {
  songs: { id: string; title: string; artist: string | null; rawLyrics: string; deletedAt: string | null; sections: { id: string; kind: string; label: string; detection: string; text: string }[] }[];
  arrangements: { id: string; songId: string; name: string; themeRef: unknown; fontId: string | null; occurrences: StoredOccurrence[] }[];
  entityStates: { key: string; dirty: number; localGeneration: number; serverRevision: string | null }[];
  songIndex: { id: string; titleKey: string }[];
  revisions: unknown[];
};

/** Lê o banco direto pela API do navegador, sem passar pelo código do aplicativo. */
function readStored(page: Page): Promise<Stored> {
  return page.evaluate(
    () =>
      new Promise<Stored>((resolve, reject) => {
        const request = indexedDB.open('louvorvisual');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const names = ['songs', 'arrangements', 'entityStates', 'songIndex', 'revisions'] as const;
          const transaction = db.transaction([...names], 'readonly');
          const result: Record<string, unknown[]> = {};
          for (const name of names) {
            const all = transaction.objectStore(name).getAll();
            all.onsuccess = () => (result[name] = all.result);
          }
          transaction.oncomplete = () => {
            db.close();
            resolve(result as unknown as Stored);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
}

async function openOffline(page: Page, path: string) {
  const response = await page.goto(`${ORIGIN}${path}`);
  expect(response?.status(), path).toBe(200);
  expect(response?.fromServiceWorker(), `${path} deve vir do service worker`).toBe(true);
}

const cards = (page: Page) => page.getByTestId('occurrence');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

/** O que as miniaturas mostram, na ordem da tela. */
function shown(page: Page) {
  return cards(page).evaluateAll((items) =>
    items.map((item) => ({
      id: item.getAttribute('data-occurrence-id'),
      text: item.querySelector('[data-slide-text]')?.textContent ?? '',
      durationMs: item.querySelector('[data-testid="timer"]')?.getAttribute('data-duration-ms'),
    })),
  );
}

async function setTimer(card: Locator, position: number, seconds: string) {
  await card.getByRole('button', { name: new RegExp(`(Adicionar tempo ao|Alterar tempo do) slide ${position}`) }).click();
  const field = card.getByLabel(`Tempo do slide ${position}, em segundos`);
  await field.fill(seconds);
  await field.press('Enter');
}

test('AT-01, AT-02, AT-03 e edição do AT-27: cadastra, edita, fecha, desliga a rede e reabre', async () => {
  let context = await profile.open();
  let page = await context.newPage();
  await page.goto(`${ORIGIN}/app`);
  await waitUntilInstalled(page);
  await expect(page.getByTestId('library-empty')).toBeVisible();

  // ── AT-01: cadastro com título, artista e letra original ────────────────
  await page.getByRole('button', { name: 'Novo louvor' }).click();
  await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();
  await expect(page.getByText('Informe o título.')).toBeVisible();
  await page.getByLabel('Título').fill('Em União');
  await page.getByLabel('Artista').fill('Coral da Vila');
  await page.getByLabel('Letra').fill(LYRICS);
  await expect(page.getByTestId('suggestion-summary')).toHaveAttribute('data-sections', '3');
  await expect(page.getByTestId('suggestion-summary')).toHaveAttribute('data-slides', '4');
  await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();

  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(cards(page)).toHaveCount(4);
  let stored = await readStored(page);
  expect(stored.songs).toHaveLength(1);
  const song = stored.songs[0]!;
  expect(song.rawLyrics).toBe(LYRICS);
  expect(song).toMatchObject({ title: 'Em União', artist: 'Coral da Vila', deletedAt: null });
  expect(stored.arrangements).toHaveLength(1);
  expect(stored.arrangements[0]).toMatchObject({ songId: song.id, name: 'Culto', fontId: null, themeRef: { kind: 'builtin', presetId: 'grafite' } });
  // Documento e pendência gravados juntos, ainda sem revisão de servidor.
  expect(stored.entityStates.map((state) => [state.key, state.dirty, state.localGeneration, state.serverRevision]).sort()).toEqual(
    [
      [`arrangement:${stored.arrangements[0]!.id}`, 1, 1, null],
      [`song:${song.id}`, 1, 1, null],
    ].sort(),
  );

  // ── AT-02: marcadores, refrão repetido e incerteza visível ──────────────
  expect(song.sections.map(({ kind, label, detection }) => ({ kind, label, detection }))).toEqual([
    { kind: 'verse', label: 'Estrofe 1', detection: 'explicit' },
    { kind: 'chorus', label: 'Refrão', detection: 'explicit' },
    { kind: 'unknown', label: 'Trecho 1', detection: 'suggested' },
  ]);
  await expect(page.getByTestId('section')).toHaveCount(3);
  await expect(page.getByTestId('section').nth(2).getByTestId('section-detection')).toContainText('Sugestão incerta');
  await expect(page.getByTestId('section').nth(1).getByTestId('section-detection')).toHaveText('Marcador da letra');
  await expect(cards(page).getByTestId('occurrence-label')).toHaveText(['1 · Estrofe 1', '2 · Refrão', '3 · Refrão', '4 · Trecho 1']);
  const initial = stored.arrangements[0]!.occurrences;
  expect(initial[1]!.id).not.toBe(initial[2]!.id);
  expect(initial[1]!.sourceSectionId).toBe(initial[2]!.sourceSectionId);
  expect(initial[1]!.text).toBe(initial[2]!.text);
  expect(initial.map((occurrence) => occurrence.durationMs)).toEqual([null, null, null, null]);

  // ── AT-27 (edição): tempo direto na miniatura, null quando ausente ──────
  await expect(cards(page).nth(1).getByText('Sem temporizador')).toBeVisible();
  await cards(page).nth(1).getByRole('button', { name: 'Adicionar tempo ao slide 2' }).click();
  const field = cards(page).nth(1).getByLabel('Tempo do slide 2, em segundos');
  await expect(field).toHaveValue('8');
  // A sugestão ainda não vale: só depois de aplicar.
  await expect(cards(page).nth(1).getByTestId('timer')).toHaveAttribute('data-duration-ms', 'null');
  await field.fill('0');
  await expect(cards(page).nth(1).getByText('Use de 0,5 a 600 segundos.')).toBeVisible();
  await field.press('Enter');
  await expect(cards(page).nth(1).getByTestId('timer')).toHaveAttribute('data-duration-ms', 'null');
  await field.fill('7');
  await cards(page).nth(1).getByRole('button', { name: 'Aumentar um segundo' }).click();
  await expect(field).toHaveValue('8');
  await field.press('Enter');
  await expect(cards(page).nth(1).getByTestId('timer')).toHaveAttribute('data-duration-ms', '8000');
  // A repetição do refrão é independente.
  await expect(cards(page).nth(2).getByTestId('timer')).toHaveAttribute('data-duration-ms', 'null');
  await setTimer(cards(page).nth(2), 3, '12');
  await cards(page).nth(1).getByRole('button', { name: 'Remover tempo do slide 2' }).click();
  expect((await shown(page)).map((item) => item.durationMs)).toEqual(['null', 'null', '12000', 'null']);
  await setTimer(cards(page).nth(1), 2, '8');
  await setTimer(cards(page).nth(3), 4, '0,5');
  expect((await shown(page)).map((item) => item.durationMs)).toEqual(['null', '8000', '12000', '500']);
  await saved(page);
  stored = await readStored(page);
  expect(stored.arrangements[0]!.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([null, 8000, 12000, 500]);

  // ── AT-03: dividir, unir, repetir, reordenar, editar e desfazer ─────────
  const allLines = async () => (await shown(page)).flatMap((item) => item.text.split('\n'));
  const linesBefore = await allLines();

  await cards(page).nth(0).getByRole('button', { name: 'Dividir slide 1' }).click();
  await cards(page).nth(0).getByRole('button', { name: 'Dividir depois da linha 1' }).click();
  await expect(cards(page)).toHaveCount(5);
  expect((await shown(page)).slice(0, 2)).toMatchObject([
    { id: initial[0]!.id, text: 'Com esperança eu vou caminhar', durationMs: 'null' },
    { text: 'E com minha voz agradecer', durationMs: 'null' },
  ]);

  // Dividir um slide com tempo distribui os 8 s; unir de volta soma.
  await cards(page).nth(2).getByRole('button', { name: 'Dividir slide 3' }).click();
  await cards(page).nth(2).getByRole('button', { name: 'Dividir depois da linha 1' }).click();
  await expect(cards(page)).toHaveCount(6);
  expect((await shown(page)).map((item) => item.durationMs)).toEqual(['null', 'null', '4000', '4000', '12000', '500']);
  expect(await allLines()).toEqual(linesBefore);

  await cards(page).nth(2).getByLabel('Selecionar slide 3').check();
  await cards(page).nth(4).getByLabel('Selecionar slide 5').check();
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Unir' }).click();
  await expect(page.getByTestId('editor-notice')).toContainText('Só é possível unir slides vizinhos');
  await expect(cards(page)).toHaveCount(6);
  await cards(page).nth(4).getByLabel('Selecionar slide 5').uncheck();
  await cards(page).nth(3).getByLabel('Selecionar slide 4').check();
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Unir' }).click();
  await expect(cards(page)).toHaveCount(5);
  expect((await shown(page))[2]).toMatchObject({ id: initial[1]!.id, text: 'Hoje cantamos em união\nCom alegria no coração', durationMs: '8000' });

  // Unir um slide com tempo a outro sem tempo: resultado sem temporizador, com aviso; desfazer restaura.
  await cards(page).nth(1).getByLabel('Selecionar slide 2').check();
  await cards(page).nth(2).getByLabel('Selecionar slide 3').check();
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Unir' }).click();
  await expect(cards(page)).toHaveCount(4);
  await expect(page.getByTestId('editor-notice')).toContainText('ficou sem temporizador');
  expect((await shown(page))[1]!.durationMs).toBe('null');
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(cards(page)).toHaveCount(5);
  expect((await shown(page)).map((item) => item.durationMs)).toEqual(['null', 'null', '8000', '12000', '500']);

  // Reordenar por botões: o trecho final sobe uma posição; IDs e tempos acompanham.
  await cards(page).nth(4).getByRole('button', { name: 'Mover slide 5 para antes' }).click();
  expect((await shown(page)).map((item) => [item.id, item.durationMs]).slice(3)).toEqual([
    [initial[3]!.id, '500'],
    [initial[2]!.id, '12000'],
  ]);

  // Repetir cria ocorrência nova com os valores iniciais; depois os tempos são independentes.
  await cards(page).nth(2).getByRole('button', { name: 'Repetir slide 3' }).click();
  await expect(cards(page)).toHaveCount(6);
  const repeated = (await shown(page))[3]!;
  expect(repeated).toMatchObject({ text: 'Hoje cantamos em união\nCom alegria no coração', durationMs: '8000' });
  expect([initial[1]!.id, initial[2]!.id]).not.toContain(repeated.id);
  await setTimer(cards(page).nth(3), 4, '10');
  expect((await shown(page)).map((item) => item.durationMs)).toEqual(['null', 'null', '8000', '10000', '500', '12000']);
  await page.getByRole('button', { name: 'Desfazer' }).click();
  expect((await shown(page))[3]!.durationMs).toBe('8000');
  await page.getByRole('button', { name: 'Refazer' }).click();
  expect((await shown(page))[3]!.durationMs).toBe('10000');

  // Editar o texto de uma ocorrência não toca na letra original nem nas outras.
  await cards(page).nth(0).getByRole('button', { name: 'Editar texto do slide 1' }).click();
  await cards(page).nth(0).getByLabel('Texto do slide 1').fill('Com esperança eu vou caminhar, sim!');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saving');
  await cards(page).nth(0).getByRole('button', { name: 'Concluir' }).click();

  // Corrigir a classificação incerta.
  await page.getByTestId('section').nth(2).getByLabel('Tipo').selectOption('bridge');
  await expect(page.getByTestId('section').nth(2).getByTestId('section-detection')).toHaveText('Revisado por você');

  // Tema e fonte ficam no documento do arranjo.
  await page.getByLabel('Tema escuro').selectOption('violeta');
  await page.getByLabel('Fonte').selectOption('lato');
  await expect(cards(page).nth(0).locator('[data-slide-frame]')).toHaveCSS('background-color', 'rgb(27, 16, 51)');

  await saved(page);
  const expected = [
    { id: initial[0]!.id, text: 'Com esperança eu vou caminhar, sim!', durationMs: 'null' },
    { id: expect.any(String), text: 'E com minha voz agradecer', durationMs: 'null' },
    { id: initial[1]!.id, text: 'Hoje cantamos em união\nCom alegria no coração', durationMs: '8000' },
    { id: repeated.id, text: 'Hoje cantamos em união\nCom alegria no coração', durationMs: '10000' },
    { id: initial[3]!.id, text: 'Ó, quão bom é — louvar!', durationMs: '500' },
    { id: initial[2]!.id, text: 'Hoje cantamos em união\nCom alegria no coração', durationMs: '12000' },
  ];
  const beforeClose = await shown(page);
  expect(beforeClose).toEqual(expected);

  stored = await readStored(page);
  const arrangement = stored.arrangements[0]!;
  expect(arrangement.occurrences.map(({ id, text, durationMs, order }) => ({ id, text, durationMs, order }))).toEqual(
    beforeClose.map((item, order) => ({ id: item.id, text: item.text, durationMs: item.durationMs === 'null' ? null : Number(item.durationMs), order })),
  );
  expect(new Set(arrangement.occurrences.map((occurrence) => occurrence.id)).size).toBe(6);
  expect(arrangement).toMatchObject({ themeRef: { kind: 'builtin', presetId: 'violeta' }, fontId: 'lato' });
  expect(stored.songs[0]!.rawLyrics).toBe(LYRICS);
  expect(stored.songs[0]!.sections[2]).toMatchObject({ kind: 'bridge', detection: 'manual' });
  const generationBeforeClose = stored.entityStates.find((state) => state.key === `arrangement:${arrangement.id}`)!.localGeneration;
  expect(generationBeforeClose).toBeGreaterThan(10);
  await context.close();

  // ── Fechar tudo, encerrar o servidor e reabrir sem rede ─────────────────
  await server.stop();
  expect(await isReachable()).toBe(false);

  context = await profile.open({ offline: true });
  page = await context.newPage();
  await openOffline(page, '/app');
  await expect(page.getByTestId('library-item')).toHaveCount(1);
  // Busca local sem acento, por título e por letra.
  await page.getByLabel('Buscar por título, artista, etiqueta ou letra').fill('uniao');
  await expect(page.getByTestId('library-item')).toHaveCount(1);
  await page.getByLabel('Buscar por título, artista, etiqueta ou letra').fill('quao bom louvar');
  await expect(page.getByTestId('library-item')).toHaveCount(1);
  await page.getByLabel('Buscar por título, artista, etiqueta ou letra').fill('inexistente');
  await expect(page.getByTestId('library-item')).toHaveCount(0);
  await page.getByLabel('Buscar por título, artista, etiqueta ou letra').fill('coral');
  if (process.env.LV_EVIDENCE) await page.screenshot({ path: `${process.env.LV_EVIDENCE}/offline-biblioteca-busca.png`, fullPage: true });
  await page.getByRole('link', { name: 'Em União' }).click();

  await expect(cards(page)).toHaveCount(6);
  expect(await shown(page)).toEqual(expected);
  await expect(page.getByRole('textbox', { name: 'Letra' })).toHaveValue(LYRICS);
  await expect(page.getByLabel('Tema escuro')).toHaveValue('violeta');
  await expect(page.getByLabel('Fonte')).toHaveValue('lato');
  await expect(page.getByTestId('section').nth(2).getByLabel('Tipo')).toHaveValue('bridge');

  // Editar offline: remover um tempo, configurar outro e reordenar.
  await cards(page).nth(5).getByRole('button', { name: 'Remover tempo do slide 6' }).click();
  await setTimer(cards(page).nth(0), 1, '6,5');
  await cards(page).nth(1).getByRole('button', { name: 'Mover slide 2 para antes' }).click();
  await saved(page);
  const offlineExpected = [expected[1]!, { ...expected[0]!, durationMs: '6500' }, expected[2]!, expected[3]!, expected[4]!, { ...expected[5]!, durationMs: 'null' }];
  expect(await shown(page)).toEqual(offlineExpected);
  await context.close();

  // ── Segunda reabertura offline, direto na URL do editor ─────────────────
  context = await profile.open({ offline: true });
  page = await context.newPage();
  await openOffline(page, `/app?view=editor&song=${song.id}`);
  await expect(cards(page)).toHaveCount(6);
  expect(await shown(page)).toEqual(offlineExpected);
  stored = await readStored(page);
  expect(stored.arrangements[0]!.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([null, 6500, 8000, 10000, 500, null]);
  expect(stored.songs[0]!.rawLyrics).toBe(LYRICS);
  const finalState = stored.entityStates.find((state) => state.key === `arrangement:${arrangement.id}`)!;
  expect(finalState.dirty).toBe(1);
  expect(finalState.localGeneration).toBe(generationBeforeClose + 3);
  // Captura opcional para o relatório da etapa: LV_EVIDENCE=<pasta>.
  if (process.env.LV_EVIDENCE) await page.screenshot({ path: `${process.env.LV_EVIDENCE}/offline-editor.png`, fullPage: true });

  await page.getByRole('link', { name: 'Disponível offline' }).click();
  await expect(page.getByTestId('local-data')).toHaveAttribute('data-songs', '1');
  await expect(page.getByTestId('local-data')).toHaveAttribute('data-pending', '2');
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});

test('texto digitado e ainda em debounce é gravado ao sair do editor; regenerar guarda revisão', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/app?view=novo`);
  await page.getByLabel('Título').fill('Manhã de Gratidão');
  await page.getByLabel('Letra').fill('A luz chegou sobre a cidade\n\nCantamos juntos, gratidão');
  await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();
  await expect(cards(page)).toHaveCount(2);

  // Sai para a biblioteca imediatamente depois de digitar, antes dos 400 ms.
  await page.getByLabel('Artista').fill('Grupo Manhã');
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await expect(page.getByTestId('library-item')).toContainText('Grupo Manhã');
  expect((await readStored(page)).songs[0]!.artist).toBe('Grupo Manhã');

  // Título repetido é só um aviso.
  await page.getByRole('button', { name: 'Novo louvor' }).click();
  await page.getByLabel('Título').fill('manha de gratidao');
  await expect(page.getByTestId('similar-songs')).toContainText('abrir “Manhã de Gratidão”');
  await page.getByRole('button', { name: 'Cancelar' }).click();

  // Alterar a letra não muda os slides; regenerar mostra prévia e guarda a versão anterior.
  await page.getByRole('link', { name: 'Manhã de Gratidão' }).click();
  await setTimer(cards(page).nth(0), 1, '9');
  await page.getByRole('textbox', { name: 'Letra' }).fill('[Refrão 2x]\nCantamos juntos, gratidão');
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Regenerar slides a partir da letra…' }).click();
  await expect(page.getByTestId('regenerate-preview')).toContainText('1 seção e 2 slides');
  await page.getByRole('button', { name: 'Substituir pelos slides sugeridos' }).click();
  await expect(cards(page).getByTestId('occurrence-label')).toHaveText(['1 · Refrão', '2 · Refrão']);
  await saved(page);
  let stored = await readStored(page);
  // Louvor e arranjo como estavam antes de regenerar. O histórico automático já tinha
  // guardado, na primeira edição de cada um, a versão de quando foram criados.
  const reasons = (stored.revisions as { reason: string; entityType: string }[]).map((revision) => `${revision.entityType}:${revision.reason}`).sort();
  expect(reasons).toEqual(['arrangement:edit', 'arrangement:regenerate', 'song:edit', 'song:regenerate']);
  expect(stored.arrangements[0]!.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([null, null]);

  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(cards(page).getByTestId('occurrence-label')).toHaveText(['1 · Trecho 1', '2 · Trecho 2']);
  await saved(page);
  stored = await readStored(page);
  expect(stored.arrangements[0]!.occurrences.map((occurrence) => occurrence.durationMs)).toEqual([9000, null]);
  expect(stored.songs[0]!.rawLyrics).toBe('[Refrão 2x]\nCantamos juntos, gratidão');

  // Duplicar e excluir na biblioteca.
  await page.getByRole('button', { name: '← Biblioteca' }).click();
  await page.getByRole('button', { name: 'Duplicar Manhã de Gratidão' }).click();
  await expect(page.getByTestId('library-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Excluir Manhã de Gratidão (cópia)' }).click();
  await page.getByRole('button', { name: 'Mover para a lixeira' }).click();
  await expect(page.getByTestId('library-item')).toHaveCount(1);
  stored = await readStored(page);
  expect(stored.songs).toHaveLength(2);
  expect(stored.songs.filter((item) => item.deletedAt !== null)).toHaveLength(1);
  await context.close();

  expect(profile.consoleErrors).toEqual([]);
  expect(profile.externalRequests()).toEqual([]);
});
