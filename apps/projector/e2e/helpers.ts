import { expect, type Page } from '@playwright/test';
import type { MockControls } from '../src/host/mock/mockHost';
import type { ProjectorSession } from '../src/presentation/session';

declare global {
  interface Window {
    __lvMock: MockControls;
    __lvSession: ProjectorSession;
    __lvInput: { accepted: string[]; stats: Record<string, number> };
  }
}

export const APP = '/assets/index.html?host=mock';

/** Teclas do teclado que o host simulado entrega como teclas do controle. */
export const KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape', menu: 'm', playPause: ' ' } as const;
export type Remote = keyof typeof KEY;

export type Watch = { requests: string[]; failed: string[]; errors: string[] };

/** Registra tudo o que a página pede e todo erro de console (inclusive violação de CSP). */
export function watch(page: Page): Watch {
  const seen: Watch = { requests: [], failed: [], errors: [] };
  page.on('request', (request) => seen.requests.push(request.url()));
  page.on('requestfailed', (request) => seen.failed.push(request.url()));
  page.on('console', (message) => message.type() === 'error' && seen.errors.push(message.text()));
  page.on('pageerror', (error) => seen.errors.push(error.message));
  return seen;
}

export async function open(page: Page, extra = ''): Promise<void> {
  await page.goto(APP + extra);
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen', 'home');
  await expectFocus(page, 'card-setlists', 'home');
}

/** Um toque no controle: pressiona e solta, pelo teclado. */
export async function press(page: Page, ...keys: Remote[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(KEY[key]);
}

export type FocusState = { id: string | null; layer: string | null; visible: boolean };

/** Onde está o foco de verdade: o elemento ativo do documento e a camada que o contém. */
export function focusState(page: Page): Promise<FocusState> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    return {
      id: element?.getAttribute('data-testid') ?? element?.getAttribute('data-focus-key') ?? null,
      layer: element?.closest('[data-layer]')?.getAttribute('data-layer') ?? null,
      visible: Boolean(element && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden' && element.matches('[data-focusable]:not([disabled])')),
    };
  });
}

export async function expectFocus(page: Page, id: string | RegExp, layer: string): Promise<void> {
  await expect.poll(() => focusState(page), { message: `foco esperado em ${String(id)} (${layer})` }).toMatchObject({ id: typeof id === 'string' ? id : expect.stringMatching(id), layer, visible: true });
}

export const stage = (page: Page) => page.getByTestId('stage');
export const slideIndex = async (page: Page) => Number(await stage(page).getAttribute('data-slide-index'));
export const commands = (page: Page) => page.evaluate(() => [...window.__lvSession.commandLog]);
export const inputStats = (page: Page) => page.evaluate(() => ({ ...window.__lvInput.stats }));
export const requested = (page: Page, method: string) => page.evaluate((name) => window.__lvMock.requests.filter((request) => request.method === name).length, method);

/** Do início até o louvor `item` (0 = primeiro) do primeiro repertório, com a pergunta "Iniciar" aberta. */
export async function prepareFromSetlist(page: Page, item = 0): Promise<void> {
  await press(page, 'ok');
  await expectFocus(page, /^setlist:/, 'setlists');
  await press(page, 'ok');
  await expectFocus(page, /^item:/, 'setlist');
  for (let step = 0; step < item; step += 1) await press(page, 'down');
  await press(page, 'ok');
  await expectFocus(page, 'ready-start', 'ready');
}

export async function startFromSetlist(page: Page, item = 0): Promise<void> {
  await prepareFromSetlist(page, item);
  await press(page, 'ok');
  await expect(stage(page)).toHaveAttribute('data-overlay', 'none');
  await expectFocus(page, 'slide-focus', 'slide');
}

/** Repete uma seta até o foco chegar ao elemento; itens desabilitados são pulados pela própria interface. */
export async function moveTo(page: Page, id: string, key: Remote = 'down', limit = 25): Promise<void> {
  for (let step = 0; step < limit && (await focusState(page)).id !== id; step += 1) await press(page, key);
  expect((await focusState(page)).id).toBe(id);
}
