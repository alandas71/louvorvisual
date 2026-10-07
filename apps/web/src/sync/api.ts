import { apiErrorSchema, syncBootstrapResponseSchema, syncPullResponseSchema, syncPushResponseSchema, type SyncOperation } from '@louvorvisual/contracts';
import { TransportError, type AssetDoc, type AssetRegistration, type IdentityCheck, type SyncTransport } from '@louvorvisual/sync';
import type { AccountUser, AccountWorkspace, TeamRole } from './profiles';

/** Origem pública única: o navegador chama /api e o Next encaminha à API (planejamento/12). */
const BASE = '/api/v1';
const CLIENT_VERSION = '0.1.0';
const TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** Cada parte do envio é pequena; se demorar mais que isso, a conexão caiu e a parte é repetida. */
const CHUNK_TIMEOUT_MS = 2 * 60_000;

type Parser<T> = { parse(value: unknown): T };
type RequestOptions<T> = { body?: unknown; bytes?: Blob; headers?: Record<string, string>; schema?: Parser<T>; timeoutMs?: number; blob?: boolean; onBlobProgress?: (loadedBytes: number) => void };

/** Lê o corpo em fluxo para informar os bytes já recebidos. */
async function readBlob(response: Response, onProgress: (loadedBytes: number) => void): Promise<Blob> {
  const reader = response.body!.getReader();
  const parts: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }
  return new Blob(parts, { type: response.headers.get('content-type') ?? '' });
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Chamada à API com o envelope `{ data, requestId }`. Falha de rede, tempo
 * esgotado ou resposta que não veio da API (proxy sem backend) são `network`:
 * a operação pode ter sido aceita, e quem chama repete a mesma tentativa.
 */
export async function apiRequest<T>(method: string, path: string, options: RequestOptions<T> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-louvorvisual-client-version': CLIENT_VERSION, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.bytes ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransportError('network', 0, 'NETWORK_ERROR', error instanceof Error ? error.message : 'Sem conexão com o servidor.');
  }

  if (response.ok && options.blob) {
    try {
      return (options.onBlobProgress && response.body ? await readBlob(response, options.onBlobProgress) : await response.blob()) as T;
    } catch (error) {
      throw new TransportError('network', 0, 'NETWORK_ERROR', error instanceof Error ? error.message : 'A transferência foi interrompida.');
    }
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TransportError('network', response.status, 'API_UNAVAILABLE', 'O servidor de sincronização não respondeu.');
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (!parsed.success) throw new TransportError('network', response.status, 'API_UNAVAILABLE', 'O servidor de sincronização não respondeu.');
    const { code, message, details } = parsed.data.error;
    throw new TransportError('http', response.status, code, message, { details, retryAfterMs: retryAfterMs(response) });
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!options.schema) return data as T;
  try {
    return options.schema.parse(data);
  } catch (error) {
    throw new TransportError('contract', response.status, 'CONTRACT_MISMATCH', `Resposta fora do contrato em ${method} ${path}.`, { details: error });
  }
}

export type Me = { user: AccountUser; workspaces: AccountWorkspace[] };
export type Member = { workspaceId: string; userId: string; role: TeamRole; status: 'active' | 'revoked'; user: AccountUser };

/** Conta, equipe e membros: sempre online; nenhuma resposta daqui é guardada em cache. */
export const accountApi = {
  me: () => apiRequest<Me>('GET', '/auth/me'),
  register: (input: { name: string; email: string; password: string }) => apiRequest<{ user: AccountUser }>('POST', '/auth/register', { body: input }),
  login: (input: { email: string; password: string }) => apiRequest<{ user: AccountUser }>('POST', '/auth/login', { body: input }),
  logout: () => apiRequest<{ loggedOut: boolean }>('POST', '/auth/logout'),
  refresh: () => apiRequest<unknown>('POST', '/auth/refresh'),
  createWorkspace: (name: string, timezone: string) => apiRequest<{ id: string; name: string }>('POST', '/workspaces', { body: { name, timezone } }),
  members: (workspaceId: string) => apiRequest<Member[]>('GET', `/workspaces/${workspaceId}/members`),
  invite: (workspaceId: string, email: string, role: TeamRole) => apiRequest<{ token: string }>('POST', `/workspaces/${workspaceId}/invitations`, { body: { email, role } }),
  acceptInvitation: (token: string) => apiRequest<{ workspaceId: string; role: TeamRole }>('POST', `/invitations/${encodeURIComponent(token)}/accept`),
  updateMember: (workspaceId: string, userId: string, patch: { role?: TeamRole; status?: 'active' | 'revoked' }) =>
    apiRequest<Member>('PATCH', `/workspaces/${workspaceId}/members/${userId}`, { body: patch }),
};

/** Sessão online atual, ou `null` quando não há login. Falha de rede propaga. */
export async function currentAccount(): Promise<Me | null> {
  try {
    return await accountApi.me();
  } catch (error) {
    if (error instanceof TransportError && error.kind === 'http' && error.status === 401) return null;
    throw error;
  }
}

type ServerAsset = { id: string; state: AssetRegistration['state']; uploadId: string; receivedBytes?: number };
const registration = (asset: ServerAsset): AssetRegistration => ({ id: asset.id, state: asset.state, uploadId: asset.uploadId, receivedBytes: asset.receivedBytes ?? 0 });

/** Transporte de um perfil de equipe: todas as chamadas levam o espaço e conferem a conta. */
export class HttpSyncTransport implements SyncTransport {
  private readonly root: string;

  constructor(
    private readonly scope: { workspaceId: string; userId: string },
    private readonly onAccount?: (me: Me) => void,
  ) {
    this.root = `/workspaces/${scope.workspaceId}`;
  }

  async checkIdentity(): Promise<IdentityCheck> {
    try {
      const me = await accountApi.me();
      if (me.user.id !== this.scope.userId) return 'mismatch';
      this.onAccount?.(me);
      return 'ok';
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'http' && error.status === 401) return 'unauthenticated';
      if (error instanceof TransportError && error.kind === 'network') return 'unreachable';
      throw error;
    }
  }

  async refreshSession(): Promise<boolean> {
    try {
      await accountApi.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async push(deviceId: string, operations: readonly SyncOperation[]) {
    const data = await apiRequest('POST', `${this.root}/sync/push`, { body: { deviceId, clientSchemaVersion: 1, operations }, schema: syncPushResponseSchema });
    return data.results;
  }

  pull(cursor: string, limit: number) {
    return apiRequest('GET', `${this.root}/sync/pull?cursor=${cursor}&limit=${limit}`, { schema: syncPullResponseSchema });
  }

  bootstrapStart(limit: number) {
    return apiRequest('POST', `${this.root}/sync/bootstrap`, { body: { limit }, schema: syncBootstrapResponseSchema });
  }

  bootstrapPage(token: string, cursor: string, limit: number) {
    return apiRequest('GET', `${this.root}/sync/bootstrap/${token}?cursor=${cursor}&limit=${limit}`, { schema: syncBootstrapResponseSchema });
  }

  async registerAsset(asset: AssetDoc): Promise<AssetRegistration> {
    const { id, sha256, filename, mimeType, byteSize, audioKind, durationMs } = asset;
    return registration(await apiRequest<ServerAsset>('POST', `${this.root}/assets`, { body: { id, sha256, filename, mimeType, byteSize, audioKind, durationMs } }));
  }

  async uploadAssetChunk(asset: AssetDoc, uploadId: string, offset: number, chunk: Blob): Promise<AssetRegistration> {
    // O arquivo vai em partes; um envio interrompido continua da posição que o servidor já tem.
    return registration(
      await apiRequest<ServerAsset>('PATCH', `${this.root}/assets/${asset.id}/content`, {
        bytes: chunk,
        headers: { 'content-type': asset.mimeType, 'upload-attempt-id': uploadId, 'upload-offset': String(offset) },
        timeoutMs: CHUNK_TIMEOUT_MS,
      }),
    );
  }

  downloadAsset(asset: AssetDoc, onProgress?: (loadedBytes: number) => void): Promise<Blob> {
    return apiRequest<Blob>('GET', `${this.root}/assets/${asset.id}/content`, { blob: true, timeoutMs: TRANSFER_TIMEOUT_MS, onBlobProgress: onProgress });
  }
}
