import type { SyncBootstrapResponse, SyncOperation, SyncPullResponse, SyncResult } from '@louvorvisual/contracts';
import { arrangement, asset, setlist, song } from '../../contracts/src/fixtures';
import { SyncCoordinator } from './coordinator';
import { MemoryAssetBytes, MemorySyncStorage } from './memory';
import { entityKey, TransportError, type AssetDoc, type AssetRegistration, type IdentityCheck, type SyncDoc, type SyncEntityType, type SyncTransport } from './types';

export const WORKSPACE = song.workspaceId;
export const USER = song.createdBy;

type Entity = { revision: bigint; document: SyncDoc };
type Change = SyncPullResponse['changes'][number];

/**
 * Servidor de teste com a semântica do backend (apps/api): CAS por revisão,
 * resultado guardado por opId (inclusive conflito e rejeição), tombstone, ID
 * aposentado, validação de referências e log por cursor.
 */
export class FakeServer {
  readonly entities = new Map<string, Entity>();
  readonly processed = new Map<string, { hash: string; result: SyncResult }>();
  readonly events: Change[] = [];
  readonly assets = new Map<string, { state: 'pending' | 'ready'; uploadId: string; bytes: Blob | null }>();
  readonly snapshots = new Map<string, { documents: SyncBootstrapResponse['documents']; cutCursor: string }>();
  readonly expiredDevices = new Set<string>();
  readonly pushLog: { deviceId: string; userId: string; operations: SyncOperation[] }[] = [];
  minCursor = 0n;
  private ids = 0;

  revisionOf(entityType: SyncEntityType, id: string): string | null {
    return this.entities.get(entityKey(entityType, id))?.revision.toString() ?? null;
  }

  documentOf(entityType: SyncEntityType, id: string): SyncDoc | undefined {
    return this.entities.get(entityKey(entityType, id))?.document;
  }

  eventsFor(id: string): Change[] {
    return this.events.filter((event) => event.entityId === id);
  }

  uuid(): string {
    this.ids += 1;
    return `00000000-0000-4000-9000-${String(this.ids).padStart(12, '0')}`;
  }

  apply(actorId: string, operation: SyncOperation): SyncResult {
    const hash = JSON.stringify(operation);
    const prior = this.processed.get(operation.opId);
    if (prior) {
      if (prior.hash !== hash) throw new TransportError('http', 409, 'IDEMPOTENCY_KEY_REUSED', 'opId já foi usado com outro payload.');
      return prior.result;
    }
    const remember = (result: SyncResult) => {
      this.processed.set(operation.opId, { hash, result });
      return result;
    };
    const key = entityKey(operation.entityType, operation.entityId);
    const current = this.entities.get(key);
    const mismatch = (operation.action === 'create' && current) || (operation.action !== 'create' && (!current || current.revision.toString() !== operation.baseRevision));
    const deleted = current ? current.document.deletedAt !== null : false;
    const invalid = !!current && ((operation.action === 'update' && deleted) || (operation.action === 'delete' && deleted) || (operation.action === 'restore' && !deleted));
    if (mismatch || invalid) {
      return remember(current ? { opId: operation.opId, status: 'conflict', entityId: operation.entityId, currentRevision: current.revision.toString(), document: current.document } : { opId: operation.opId, status: 'rejected', code: 'ENTITY_NOT_FOUND' });
    }
    if (operation.action !== 'delete') {
      const live = (type: SyncEntityType, id: string) => {
        const entity = this.entities.get(entityKey(type, id));
        return !!entity && entity.document.deletedAt === null;
      };
      const payload = operation.payload as Record<string, unknown>;
      const missing =
        (operation.entityType === 'arrangement' && (!live('song', payload.songId as string) || (payload.audioBindings as { assetId: string }[]).some((binding) => !live('asset', binding.assetId)))) ||
        (operation.entityType === 'setlist' && (payload.items as { arrangementId: string }[]).some((item) => !live('arrangement', item.arrangementId)));
      if (missing) return remember({ opId: operation.opId, status: 'rejected', code: 'DEPENDENCY_NOT_READY' });
    }
    const revision = (current?.revision ?? 0n) + 1n;
    const stamp = '2026-10-06T00:00:00.000Z';
    const document = {
      ...operation.payload,
      ...('serverRevision' in operation.payload ? { serverRevision: revision.toString(), updatedBy: actorId } : {}),
      updatedAt: stamp,
      deletedAt: operation.action === 'delete' ? stamp : operation.action === 'restore' ? null : operation.payload.deletedAt,
    } as SyncDoc;
    this.entities.set(key, { revision, document });
    const cursor = String(this.events.length + 1);
    this.events.push({ cursor, entityType: operation.entityType, entityId: operation.entityId, revision: revision.toString(), action: operation.action, document });
    return remember({ opId: operation.opId, status: 'accepted', entityId: operation.entityId, revision: revision.toString(), cursor });
  }
}

export type Faults = {
  offline: boolean;
  /** Quantas respostas de push se perdem depois de o servidor ter confirmado. */
  loseResponses: number;
  identity: IdentityCheck;
  role: 'editor' | 'operator' | 'revoked';
  /** Chamado com o lote antes de o servidor aplicá-lo (para simular edição durante o envio). */
  beforePush: ((operations: readonly SyncOperation[]) => void | Promise<void>) | null;
  afterPull: (() => void | Promise<void>) | null;
  bootstrapExpiresOnce: boolean;
  pushStatus: { status: number; code: string } | null;
  /** Quantas chamadas seguintes respondem 401 (sessão de acesso vencida). */
  unauthorized: number;
  /** A renovação da sessão funciona? */
  refreshWorks: boolean;
};

const network = () => new TransportError('network', 0, 'NETWORK_ERROR', 'Sem conexão.');

export class FakeTransport implements SyncTransport {
  readonly faults: Faults = { offline: false, loseResponses: 0, identity: 'ok', role: 'editor', beforePush: null, afterPull: null, bootstrapExpiresOnce: false, pushStatus: null, unauthorized: 0, refreshWorks: false };
  refreshes = 0;
  readonly calls: string[] = [];

  constructor(
    readonly server: FakeServer,
    readonly userId: string = USER,
  ) {}

  private gate(name: string, write = false): void {
    this.calls.push(name);
    if (this.faults.offline) throw network();
    if (this.faults.unauthorized > 0) {
      this.faults.unauthorized -= 1;
      throw new TransportError('http', 401, 'UNAUTHORIZED', 'Não autenticado.');
    }
    if (this.faults.role === 'revoked') throw new TransportError('http', 403, 'WORKSPACE_ACCESS_REVOKED', 'Acesso ao espaço revogado.');
    if (write && this.faults.role === 'operator') throw new TransportError('http', 403, 'WORKSPACE_FORBIDDEN', 'Você não tem permissão neste espaço.');
  }

  async checkIdentity(): Promise<IdentityCheck> {
    return this.faults.offline ? 'unreachable' : this.faults.identity;
  }

  async refreshSession(): Promise<boolean> {
    this.refreshes += 1;
    if (this.faults.refreshWorks && this.faults.identity === 'unauthenticated') this.faults.identity = 'ok';
    return this.faults.refreshWorks;
  }

  async push(deviceId: string, operations: readonly SyncOperation[]): Promise<SyncResult[]> {
    this.gate('push', true);
    if (this.faults.pushStatus) throw new TransportError('http', this.faults.pushStatus.status, this.faults.pushStatus.code, 'falha simulada');
    await this.faults.beforePush?.(operations);
    if (this.server.expiredDevices.has(deviceId)) throw new TransportError('http', 410, 'DEVICE_EXPIRED', 'Dispositivo fora da janela de reconciliação.');
    const sent = structuredClone([...operations]);
    this.server.pushLog.push({ deviceId, userId: this.userId, operations: sent });
    const results = sent.map((operation) => this.server.apply(this.userId, operation));
    if (this.faults.loseResponses > 0) {
      this.faults.loseResponses -= 1;
      throw network();
    }
    return structuredClone(results);
  }

  async pull(cursor: string, limit: number): Promise<SyncPullResponse> {
    this.gate('pull');
    if (BigInt(cursor) < this.server.minCursor) throw new TransportError('http', 410, 'CURSOR_EXPIRED', 'Cursor fora da janela de retenção.');
    const pending = this.server.events.filter((event) => BigInt(event.cursor) > BigInt(cursor));
    const changes = structuredClone(pending.slice(0, limit));
    await this.faults.afterPull?.();
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor, hasMore: pending.length > limit };
  }

  async bootstrapStart(limit: number): Promise<SyncBootstrapResponse> {
    this.gate('bootstrap');
    const token = this.server.uuid();
    const documents = [...this.server.entities.entries()].map(([key, entity]) => {
      const [entityType, entityId] = key.split(':') as [SyncEntityType, string];
      return { entityType, entityId, revision: entity.revision.toString(), document: structuredClone(entity.document) };
    });
    this.server.snapshots.set(token, { documents, cutCursor: String(this.server.events.length) });
    return this.page(token, 0, limit);
  }

  async bootstrapPage(token: string, cursor: string, limit: number): Promise<SyncBootstrapResponse> {
    this.gate('bootstrapPage');
    if (this.faults.bootstrapExpiresOnce) {
      this.faults.bootstrapExpiresOnce = false;
      throw new TransportError('http', 410, 'BOOTSTRAP_EXPIRED', 'Fotografia expirada; reinicie o bootstrap.');
    }
    return this.page(token, Number(cursor), limit);
  }

  private page(token: string, start: number, limit: number): SyncBootstrapResponse {
    const snapshot = this.server.snapshots.get(token);
    if (!snapshot) throw new TransportError('http', 410, 'BOOTSTRAP_EXPIRED', 'Fotografia expirada; reinicie o bootstrap.');
    const documents = snapshot.documents.slice(start, start + limit);
    const next = start + documents.length;
    return { token, accessRevision: '0', cutCursor: snapshot.cutCursor, documents, nextCursor: String(next), hasMore: next < snapshot.documents.length };
  }

  async registerAsset(document: AssetDoc): Promise<AssetRegistration> {
    this.gate('registerAsset', true);
    const existing = this.server.assets.get(document.id);
    if (existing?.state === 'ready') return { id: document.id, state: 'ready', uploadId: existing.uploadId };
    const uploadId = this.server.uuid();
    this.server.assets.set(document.id, { state: 'pending', uploadId, bytes: null });
    return { id: document.id, state: 'pending', uploadId };
  }

  async uploadAsset(document: AssetDoc, uploadId: string, bytes: Blob): Promise<AssetRegistration> {
    this.gate('uploadAsset', true);
    const registered = this.server.assets.get(document.id);
    if (!registered || registered.uploadId !== uploadId) throw new TransportError('http', 409, 'UPLOAD_ATTEMPT_INVALID', 'Tentativa de upload inválida.');
    if (bytes.size !== document.byteSize) throw new TransportError('http', 400, 'ASSET_SIZE_MISMATCH', 'Tamanho do arquivo não confere.');
    this.server.assets.set(document.id, { state: 'ready', uploadId, bytes });
    return { id: document.id, state: 'ready', uploadId };
  }

  async downloadAsset(document: AssetDoc): Promise<Blob> {
    this.gate('downloadAsset');
    const registered = this.server.assets.get(document.id);
    if (!registered?.bytes) throw new TransportError('http', 404, 'NOT_FOUND', 'Arquivo não encontrado.');
    return registered.bytes;
  }
}

/** Um "dispositivo": armazenamento, bytes e coordenador próprios, ligados ao mesmo servidor. */
export function device(server: FakeServer, name: string, userId: string = USER) {
  let counter = 0;
  let clock = Date.parse('2026-10-06T10:00:00.000Z');
  const prefix = name.charCodeAt(0).toString(16).padStart(8, '0');
  const newId = () => {
    counter += 1;
    return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
  const storage = new MemorySyncStorage(newId());
  const bytes = new MemoryAssetBytes();
  const transport = new FakeTransport(server, userId);
  const state = { presenting: false };
  const now = () => new Date((clock += 1000)).toISOString();
  const coordinator = new SyncCoordinator({ storage, transport, assets: bytes, workspaceId: WORKSPACE, now, newId, isPresenting: () => state.presenting });
  const read = <T>(work: Parameters<MemorySyncStorage['transaction']>[0]) => storage.transaction(work) as Promise<T>;
  return {
    name,
    storage,
    bytes,
    transport,
    coordinator,
    newId,
    now,
    state,
    advance: (ms: number) => void (clock += ms),
    sync: () => coordinator.syncOnce(),
    save: (entityType: SyncEntityType, document: SyncDoc) => storage.saveLocal(entityType, document),
    doc: (entityType: SyncEntityType, id: string) => read<SyncDoc | undefined>((tx) => tx.getDocument(entityType, id)),
    stateOf: (entityType: SyncEntityType, id: string) => storage.transaction((tx) => tx.getState(entityKey(entityType, id))),
    operations: () => storage.transaction((tx) => tx.listOperations()),
    conflicts: () => storage.transaction(async (tx) => (await tx.listConflicts()).filter((conflict) => conflict.status === 'open')),
    meta: () => storage.transaction((tx) => tx.getMeta()),
  };
}

export type Device = ReturnType<typeof device>;

export const fixtures = { song: song as SyncDoc, arrangement: arrangement as SyncDoc, asset: asset as AssetDoc, setlist: setlist as SyncDoc };

/** Louvor de teste com outro ID, para cenários com vários registros. */
export function songDoc(id: string, title: string): SyncDoc {
  return { ...song, id, title } as SyncDoc;
}

export function titled(document: SyncDoc, title: string): SyncDoc {
  return { ...document, title } as SyncDoc;
}

export function titleOf(document: SyncDoc | undefined): unknown {
  return (document as Record<string, unknown> | undefined)?.title;
}
