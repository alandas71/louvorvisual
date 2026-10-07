import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';

export const PORT = 3310;
export const ORIGIN = `http://localhost:${PORT}`;

const webRoot = join(__dirname, '..');
const nextBin = createRequire(__filename).resolve('next/dist/bin/next');

/** Servidor de produção (`next start`) sobre o build existente. */
export class ProductionServer {
  private child: ChildProcess | null = null;

  async start(): Promise<void> {
    this.child = spawn(process.execPath, [nextBin, 'start', '-p', String(PORT)], { cwd: webRoot, stdio: 'ignore' });
    await expect.poll(() => isReachable(), { timeout: 30_000 }).toBe(true);
  }

  /** Encerra o processo e confirma que a origem deixou de responder. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await expect.poll(() => isReachable(), { timeout: 15_000 }).toBe(false);
  }
}

export async function isReachable(): Promise<boolean> {
  try {
    await fetch(`${ORIGIN}/app`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Perfil de navegador em disco, para fechar o processo e reabrir com os mesmos dados. */
export class BrowserProfile {
  readonly dir = mkdtempSync(join(tmpdir(), 'louvorvisual-e2e-'));
  /** Todas as URLs pedidas por páginas deste perfil, em qualquer abertura. */
  readonly requested: string[] = [];
  /** Documentos abertos em páginas (navegações), sem os downloads do service worker. */
  readonly navigated: string[] = [];
  readonly consoleErrors: string[] = [];

  async open(options: { offline?: boolean; blockServiceWorkers?: boolean } = {}): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(this.dir, {
      // LV_E2E_CHANNEL=chrome (ou msedge) roda a mesma suíte no navegador instalado, para a prova de compatibilidade.
      channel: process.env.LV_E2E_CHANNEL || undefined,
      offline: options.offline ?? false,
      serviceWorkers: options.blockServiceWorkers ? 'block' : 'allow',
    });
    context.on('request', (request) => {
      this.requested.push(request.url());
      if (request.isNavigationRequest()) this.navigated.push(request.url());
    });
    context.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    context.on('weberror', (error) => this.consoleErrors.push(String(error.error())));
    // Nenhum pedido sai da origem do aplicativo; se algum tentar, fica registrado.
    await context.route(
      (url) => url.origin !== ORIGIN,
      (route) => route.abort(),
    );
    return context;
  }

  /** Pedidos feitos a qualquer endereço que não seja o aplicativo. */
  externalRequests(): string[] {
    return this.requested.filter((url) => !url.startsWith(`${ORIGIN}/`) && !/^(data|blob|about|chrome):/.test(url));
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export type SwStatus = { version: string; expected: number; cached: number };

/** Espera o service worker controlar a página com o precache completo. */
export async function waitUntilInstalled(page: Page): Promise<SwStatus> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    const channel = new MessageChannel();
    const reply = new Promise<{ version: string; expected: number; cached: number }>((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    registration.active!.postMessage({ type: 'STATUS' }, [channel.port2]);
    return reply;
  });
}

export function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

/**
 * Regrava public/sw.js como se outra versão tivesse sido publicada e devolve a
 * versão gerada. Sem opções, restaura o service worker do build atual.
 */
export function publishServiceWorker(options: { salt?: string; tamper?: string } = {}): string {
  const args = Object.entries(options).map(([name, value]) => `--${name}=${value}`);
  const output = execFileSync(process.execPath, [join(webRoot, 'scripts', 'generate-sw.mjs'), ...args], { encoding: 'utf8' });
  const version = /Service worker ([0-9a-f]+):/.exec(output)?.[1];
  if (!version) throw new Error(`Saída inesperada do gerador: ${output}`);
  return version;
}
