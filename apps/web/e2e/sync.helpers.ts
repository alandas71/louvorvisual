import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN } from './helpers';

export const API_PORT = 3121;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** Banco SQL Server descartável; sem ele a demonstração de sincronização não roda. */
export const DATABASE_URL = process.env.LV_E2E_DATABASE_URL ?? '';

const apiRoot = join(__dirname, '..', '..', 'api');
const apiRequire = createRequire(join(apiRoot, 'package.json'));

async function apiReachable(): Promise<boolean> {
  try {
    return (await fetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** A API de verdade (apps/api, `src/server.ts`) sobre o banco isolado. */
export class ApiServer {
  private child: ChildProcess | null = null;
  private mediaDir: string | null = null;
  readonly output: string[] = [];

  async start(): Promise<void> {
    // Uma API esquecida na porta responderia ao /health no lugar desta, com outro banco.
    expect(await apiReachable(), `a porta ${API_PORT} já está em uso por outro processo`).toBe(false);
    this.mediaDir = mkdtempSync(join(tmpdir(), 'louvorvisual-e2e-media-'));
    this.child = spawn(process.execPath, [apiRequire.resolve('tsx/cli'), 'src/server.ts'], {
      cwd: apiRoot,
      env: { ...process.env, PORT: String(API_PORT), DATABASE_URL, WEB_ORIGIN: ORIGIN, LOUVORVISUAL_MEDIA_DIR: this.mediaDir, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Grupo próprio: o `tsx` sobe o servidor em um processo filho, e é o grupo inteiro que precisa ser encerrado.
      detached: true,
    });
    this.child.stdout?.on('data', (chunk) => this.output.push(String(chunk)));
    this.child.stderr?.on('data', (chunk) => this.output.push(String(chunk)));
    await expect.poll(apiReachable, { timeout: 60_000, message: 'a API de teste não respondeu em /health' }).toBe(true);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      await exited;
    }
    await expect.poll(apiReachable, { timeout: 15_000, message: 'a API de teste continuou no ar depois de encerrada' }).toBe(false);
    if (this.mediaDir) { rmSync(this.mediaDir, { recursive: true, force: true }); this.mediaDir = null; }
  }
}

type Sql = { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>; $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>; $disconnect(): Promise<void> };

/** Acesso direto ao banco isolado, só para simular retenção vencida (AT-23) e conferir o servidor. */
export function sqlClient(): Sql {
  const { PrismaClient } = apiRequire('@prisma/client') as { PrismaClient: new (options: unknown) => Sql };
  return new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
}

export type PushRecord = { url: string; deviceId: string; operations: { opId: string; entityType: string; entityId: string; action: string; baseRevision: string; payload: Record<string, unknown> }[] };

/** Registra todo push e toda chamada de bootstrap feitos por um perfil de navegador. */
export function recordSync(context: BrowserContext) {
  const pushes: PushRecord[] = [];
  const bootstraps: string[] = [];
  context.on('request', (request) => {
    const url = request.url();
    if (url.includes('/sync/push') && request.method() === 'POST') pushes.push({ url, ...(request.postDataJSON() as Omit<PushRecord, 'url'>) });
    if (url.includes('/sync/bootstrap')) bootstraps.push(url);
  });
  return { pushes, bootstraps };
}

const PUSH_ROUTE = '**/api/v1/workspaces/*/sync/push';

/** O servidor confirma a operação, mas a resposta nunca chega ao navegador. */
export async function loseNextPushResponse(context: BrowserContext): Promise<void> {
  await context.route(
    PUSH_ROUTE,
    async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    },
    { times: 1 },
  );
}

/** Segura a resposta do próximo push até `release()` ser chamado. */
export async function holdNextPushResponse(context: BrowserContext): Promise<{ arrived: Promise<void>; release: () => void }> {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen = new Promise<void>((resolve) => (arrived = resolve));
  await context.route(
    PUSH_ROUTE,
    async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  return { arrived: seen, release };
}

export async function gotoView(page: Page, view: string, extra = ''): Promise<void> {
  await page.goto(`${ORIGIN}/app?view=${view}${extra}`);
}

const status = (page: Page) => page.getByTestId('sync-status');

/**
 * Abre a tela de sincronização, pede um ciclo e espera que um ciclo iniciado
 * depois do pedido termine no estado indicado.
 */
export async function syncNow(page: Page, connection: string = 'idle'): Promise<void> {
  if (!page.url().includes('view=sync')) await gotoView(page, 'sync');
  await expect(status(page)).toBeVisible();
  const cycles = async () => Number((await status(page).getAttribute('data-cycles')) ?? 0);
  // Um ciclo já em andamento pode ter lido o servidor antes do passo anterior do teste: não conta.
  const busy = (await status(page).getAttribute('data-connection')) === 'syncing';
  const target = (await cycles()) + (busy ? 2 : 1);
  await page.getByTestId('sync-now').click();
  await expect.poll(async () => (await cycles()) >= target && (await status(page).getAttribute('data-connection')) === connection, { timeout: 45_000 }).toBe(true);
}

/** Sincroniza até não restar pendência (dependências saem em ciclos e chamadas separadas). */
export async function syncUntilClean(page: Page): Promise<void> {
  await syncNow(page);
  await expect(status(page)).toHaveAttribute('data-pending', '0', { timeout: 30_000 });
  await expect(status(page)).toHaveAttribute('data-conflicts', '0');
}

/** Faz o motor rodar um ciclo sem sair da tela atual (o mesmo gatilho de "a conexão voltou"). */
export async function nudgeSync(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

export type ActiveProfile = { kind: string; profileId: string; workspaceId: string; userId: string; dbName: string };

export async function activeProfile(page: Page): Promise<ActiveProfile> {
  if (!page.url().includes('view=conta')) await gotoView(page, 'conta');
  const element = page.getByTestId('active-profile');
  await expect(element).toBeVisible();
  const read = async (name: string) => (await element.getAttribute(name)) ?? '';
  const kind = await read('data-kind');
  const profileId = await read('data-profile-id');
  return { kind, profileId, workspaceId: await read('data-workspace-id'), userId: await read('data-user-id'), dbName: kind === 'team' ? `louvorvisual-team-${profileId}` : 'louvorvisual' };
}

type Row = Record<string, unknown>;

/** Lê tabelas do IndexedDB direto pela API do navegador; blobs viram só o tamanho. */
export function readDb(page: Page, dbName: string, stores: readonly string[]): Promise<Record<string, Row[]>> {
  return page.evaluate(
    ({ name, tables }) =>
      new Promise<Record<string, Row[]>>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(tables, 'readonly');
          const result: Record<string, Row[]> = {};
          for (const table of tables) {
            const all = transaction.objectStore(table).getAll();
            all.onsuccess = () => {
              result[table] = (all.result as Row[]).map((row) => (row.blob instanceof Blob ? { ...row, blob: undefined, blobSize: row.blob.size } : row));
            };
          }
          transaction.oncomplete = () => {
            db.close();
            resolve(result);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { name: dbName, tables: [...stores] },
  );
}

export type LocalSong = { id: string; title: string; deletedAt: string | null; workspaceId: string };
export type LocalState = { key: string; dirty: number; localGeneration: number; serverRevision: string | null; conflict: string | null; deferredRemote?: { revision: string } | null; blocked?: { code: string } | null };

export async function songs(page: Page, dbName: string): Promise<LocalSong[]> {
  return (await readDb(page, dbName, ['songs'])).songs as unknown as LocalSong[];
}

export async function songByTitle(page: Page, dbName: string, title: string): Promise<LocalSong> {
  const found = (await songs(page, dbName)).find((song) => song.title === title && song.deletedAt === null);
  if (!found) throw new Error(`Louvor "${title}" não está em ${dbName}`);
  return found;
}

export async function stateOf(page: Page, dbName: string, key: string): Promise<LocalState | undefined> {
  return ((await readDb(page, dbName, ['entityStates'])).entityStates as unknown as LocalState[]).find((state) => state.key === key);
}

/** Espera o título chegar ao banco local: "salvo" na tela não basta como prova de gravação. */
export async function expectStoredTitle(page: Page, dbName: string, songId: string, title: string): Promise<void> {
  await expect.poll(async () => (await songs(page, dbName)).find((song) => song.id === songId)?.title, { timeout: 15_000 }).toBe(title);
}

/**
 * Sincroniza até o título remoto estar no banco local. Um editor fechado há
 * instantes ainda pode adiar a adoção por um ciclo; isso é esperado.
 */
export async function convergeTitle(page: Page, dbName: string, songId: string, title: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await syncNow(page);
        return (await songs(page, dbName)).find((song) => song.id === songId)?.title;
      },
      { timeout: 60_000, intervals: [0, 1_500] },
    )
    .toBe(title);
}

/** Estado do servidor, lido pela API com a sessão do perfil (cookies do contexto). */
export async function serverDocument(context: BrowserContext, workspaceId: string, plural: 'songs' | 'arrangements' | 'setlists', id: string): Promise<{ status: number; revision?: string; document?: Record<string, unknown> }> {
  const response = await context.request.get(`${ORIGIN}/api/v1/workspaces/${workspaceId}/${plural}/${id}`);
  if (!response.ok()) return { status: response.status() };
  const { data } = (await response.json()) as { data: { revision: string; document: Record<string, unknown> } };
  return { status: 200, ...data };
}

export async function serverRevisions(context: BrowserContext, workspaceId: string, type: string, id: string): Promise<string[]> {
  const response = await context.request.get(`${ORIGIN}/api/v1/workspaces/${workspaceId}/revisions/${type}/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { data: { revision: string }[] }).data.map((item) => item.revision);
}

const PASSWORD = 'senha de teste suficientemente longa';

/** Cria a conta pela tela "Conta e equipe". */
export async function register(page: Page, name: string, email: string): Promise<void> {
  await gotoView(page, 'conta');
  await page.getByRole('button', { name: 'Quero criar uma conta' }).click();
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel(/^Senha/).fill(PASSWORD);
  await page.getByTestId('auth-form').getByRole('button', { name: 'Criar conta' }).click();
}

export async function login(page: Page, email: string): Promise<void> {
  await gotoView(page, 'conta');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel(/^Senha/).fill(PASSWORD);
  await page.getByTestId('auth-form').getByRole('button', { name: 'Entrar' }).click();
}

export async function openEditor(page: Page, songId: string): Promise<void> {
  await gotoView(page, 'editor', `&song=${songId}`);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-song-id', songId);
}

/** Troca o título no editor e espera a gravação local. */
export async function retitle(page: Page, dbName: string, songId: string, title: string): Promise<void> {
  await page.getByLabel('Título').fill(title);
  await expectStoredTitle(page, dbName, songId, title);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}
