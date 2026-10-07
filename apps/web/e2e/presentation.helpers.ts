import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { ORIGIN, waitUntilInstalled } from './helpers';

// Letra original escrita para os testes deste projeto: um slide por estrofe.
export const SLIDE_TEXTS = [
  'Com esperança eu vou caminhar\nE com minha voz agradecer',
  'Hoje cantamos em união\nCom alegria no coração',
  'A luz chegou sobre a cidade\nCantamos juntos, gratidão',
  'Ó, quão bom é — louvar!\nÀ sombra da tua mão',
];

export function lyricsFor(count: number): string {
  return SLIDE_TEXTS.slice(0, count)
    .map((text, index) => `[Estrofe ${index + 1}]\n${text}`)
    .join('\n\n');
}

const cards = (page: Page) => page.getByTestId('occurrence');

/** Cadastra um louvor pela interface e define os tempos nas miniaturas (`null` = sem temporizador). */
export async function createSong(page: Page, options: { title?: string; durations: readonly (string | null)[]; install?: boolean; notes?: string }): Promise<void> {
  await page.goto(`${ORIGIN}/app`);
  if (options.install) await waitUntilInstalled(page);
  await page.getByRole('button', { name: 'Novo louvor' }).click();
  await page.getByLabel('Título').fill(options.title ?? 'Em União');
  await page.getByLabel('Artista').fill('Coral da Vila');
  await page.getByLabel('Letra').fill(lyricsFor(options.durations.length));
  await page.getByRole('button', { name: 'Salvar e revisar slides' }).click();
  await expect(cards(page)).toHaveCount(options.durations.length);
  if (options.notes) await page.getByLabel('Observações').fill(options.notes);
  for (const [index, seconds] of options.durations.entries()) {
    if (seconds === null) continue;
    const card = cards(page).nth(index);
    await card.getByRole('button', { name: `Adicionar tempo ao slide ${index + 1}` }).click();
    const field = card.getByLabel(`Tempo do slide ${index + 1}, em segundos`);
    await field.fill(seconds);
    await field.press('Enter');
    await expect(card.getByTestId('timer')).not.toHaveAttribute('data-duration-ms', 'null');
  }
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

export const operator = (page: Page): Locator => page.getByTestId('operator');
export const output = (page: Page): Locator => page.getByTestId('public-output');

/** Do editor para a área do operador, com a sessão preparada. */
export async function openOperator(page: Page): Promise<void> {
  await page.getByRole('button', { name: '▶ Apresentar' }).click();
  await expect(operator(page)).toHaveAttribute('data-status', 'ready');
}

/** Abre a janela pública pelo botão do operador (clique direto) e, por padrão, arma a saída. */
export async function openProjection(context: BrowserContext, operatorPage: Page, options: { arm?: boolean } = {}): Promise<Page> {
  const [projection] = await Promise.all([context.waitForEvent('page'), operatorPage.getByRole('button', { name: /janela de projeção/ }).click()]);
  await projection.waitForLoadState('domcontentloaded');
  await expect(output(projection)).toHaveAttribute('data-status', 'live');
  if (options.arm ?? true) {
    await projection.getByRole('button', { name: 'Armar saída' }).click();
    await expect(output(projection)).toHaveAttribute('data-armed', 'true');
    await expect(operator(operatorPage)).toHaveAttribute('data-projection-armed', 'true');
  }
  return projection;
}

/** A janela pública confirmou exatamente o estado que o operador publicou por último. */
export async function expectConfirmed(operatorPage: Page, projection: Page): Promise<void> {
  await expect
    .poll(async () => {
      const sequence = await operator(operatorPage).getAttribute('data-sequence');
      return [await operator(operatorPage).getAttribute('data-confirmed-sequence'), await output(projection).getAttribute('data-sequence')].every((value) => value === sequence);
    })
    .toBe(true);
}

/** O que a janela pública está desenhando, lido dos estilos calculados pelo navegador. */
export function drawn(page: Page, root = '[data-testid="public-output"]') {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector)!;
    const frame = scope.querySelector<HTMLElement>('[data-slide-frame]');
    if (!frame) return null;
    const composition = frame.querySelector<HTMLElement>('[data-slide-composition]')!;
    const text = frame.querySelector<HTMLElement>('[data-slide-text]')!;
    const style = getComputedStyle(text);
    const box = composition.getBoundingClientRect();
    const bounds = frame.getBoundingClientRect();
    // Largura da composição antes de girar: é a referência das medidas do tema.
    const width = composition.offsetWidth;
    return {
      text: text.textContent ?? '',
      visible: style.visibility === 'visible',
      background: getComputedStyle(frame).backgroundColor,
      color: style.color,
      family: style.fontFamily.split(',')[0]!.replace(/["']/g, '').trim(),
      weight: style.fontWeight,
      align: style.textAlign,
      fontSizeRatio: parseFloat(style.fontSize) / width,
      aspect: composition.offsetWidth / composition.offsetHeight,
      rotation: frame.getAttribute('data-rotation'),
      visualMode: frame.getAttribute('data-visual-mode'),
      // A composição girada cabe inteira na saída, sem corte.
      inside: box.left >= bounds.left - 0.5 && box.top >= bounds.top - 0.5 && box.right <= bounds.right + 0.5 && box.bottom <= bounds.bottom + 0.5,
      box: { width: box.width, height: box.height },
      clipped: text.scrollWidth > text.clientWidth + 1,
    };
  }, root);
}

export type Transition = { id: string; mode: string; at: number };

/** Registra na própria janela o instante de cada troca de slide ou de modo visual que ela recebe. */
export async function recordTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="public-output"]')!;
    const log: { id: string; mode: string; at: number }[] = [];
    (window as unknown as { lvTransitions: typeof log }).lvTransitions = log;
    const read = () => `${root.getAttribute('data-occurrence-id')}|${root.getAttribute('data-visual-mode')}`;
    let last = read();
    new MutationObserver(() => {
      const now = read();
      if (now === last) return;
      last = now;
      const [id, mode] = now.split('|') as [string, string];
      log.push({ id, mode, at: performance.timeOrigin + performance.now() });
    }).observe(root, { attributes: true, attributeFilter: ['data-occurrence-id', 'data-visual-mode'] });
  });
}

export function transitions(page: Page): Promise<Transition[]> {
  return page.evaluate(() => (window as unknown as { lvTransitions: Transition[] }).lvTransitions);
}

export function wallClock(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

export function mediaElements(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('audio, video').length);
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

/** Lê uma tabela do banco direto pela API do navegador, sem passar pelo código do aplicativo. */
export function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open('louvorvisual');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction(name, 'readonly').objectStore(name).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
  ) as Promise<T[]>;
}

/** Confere que a face desenhada é o arquivo do pacote, e não a fonte de reserva. */
export function fontInUse(page: Page, family: string, weight: number) {
  return page.evaluate(
    async ({ family, weight }) => {
      await document.fonts.ready;
      const declared = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === family && face.weight === String(weight));
      const measure = (fontFamily: string) => {
        const span = document.createElement('span');
        span.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:96px;font-weight:${weight};font-synthesis:none;font-family:${fontFamily}`;
        span.textContent = 'Coração, louvação, fé e canção ÁÀÂÃÉÊÍÓÔÕÚÜÇ áàâãéêíóôõúüç';
        document.body.append(span);
        const width = span.getBoundingClientRect().width;
        span.remove();
        return width;
      };
      return { status: declared.map((face) => face.status), withFamily: measure(`"${family}", monospace`), fallback: measure('monospace') };
    },
    { family, weight },
  );
}

/** Passa a guardar, nesta janela, tudo o que chega pelo canal local da apresentação. */
export async function recordChannel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: unknown[] = [];
    (window as unknown as { lvChannel: unknown[] }).lvChannel = log;
    const channel = new BroadcastChannel('lv-presentation');
    channel.onmessage = (event) => log.push(event.data);
    (window as unknown as { lvChannelRef: BroadcastChannel }).lvChannelRef = channel;
  });
}

export function channelLog(page: Page): Promise<{ type: string }[]> {
  return page.evaluate(() => (window as unknown as { lvChannel: { type: string }[] }).lvChannel);
}
