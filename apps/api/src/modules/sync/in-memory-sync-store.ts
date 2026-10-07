import { randomUUID } from 'node:crypto';
import type { SyncBootstrapResponse, SyncOperation, SyncPullResponse, SyncResult } from '@louvorvisual/contracts';
import { AppError } from '../../utils/AppError';
import { acceptedDocument, operationHash, type SyncDocument, type SyncStore } from './sync-store';

type Entity = { revision: bigint; document: SyncDocument };
type Event = { cursor: bigint; operation: SyncOperation; revision: bigint; document: SyncDocument };
type Revision = { revision: bigint; action: SyncOperation['action']; document: SyncDocument };
type Processed = { hash: string; result: SyncResult };
type Snapshot = { cutCursor: bigint; documents: { entityType: SyncOperation['entityType']; entityId: string; revision: string; document: SyncDocument }[]; expiresAt: number };

/** Adaptador determinístico: usa a mesma ordem crítica (documento, revisão, opId e evento). */
export class InMemorySyncStore implements SyncStore {
  private readonly entities = new Map<string, Entity>(); private readonly operations = new Map<string, Processed>();
  private readonly events = new Map<string, Event[]>(); private readonly revisionsByEntity = new Map<string, Revision[]>();
  private readonly retired = new Set<string>(); private readonly snapshots = new Map<string, Snapshot>();
  private readonly devices = new Map<string, number>(); private readonly minCursor = new Map<string, bigint>(); private tail = Promise.resolve();

  /** Ganchos de teste para simular retenção e dispositivo desconectado por muito tempo. */
  expireCursorBefore(workspaceId: string, cursor: string) { this.minCursor.set(workspaceId, BigInt(cursor)); }
  expireDevice(workspaceId: string, deviceId: string) { this.devices.set(`${workspaceId}:${deviceId}`, 0); }
  async ensureWorkspace(_workspace: { id: string; name: string; timezone: string }): Promise<void> { /* mapas são criados sob demanda */ }

  async apply(workspaceId: string, actorId: string, operation: SyncOperation, deviceId?: string): Promise<SyncResult> {
    return this.exclusive(async () => {
      if (deviceId) this.touchDevice(workspaceId, deviceId);
      const opKey = `${workspaceId}:${operation.opId}`; const hash = operationHash(operation); const prior = this.operations.get(opKey);
      if (prior) { if (prior.hash !== hash) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'opId já foi usado com outro payload.'); return prior.result; }
      const entityKey = this.entityKey(workspaceId, operation.entityType, operation.entityId); const current = this.entities.get(entityKey);
      const mismatch = (operation.action === 'create' && current) || (operation.action !== 'create' && (!current || current.revision.toString() !== operation.baseRevision));
      const invalidState = !!current && ((operation.action === 'update' && current.document.deletedAt !== null) || (operation.action === 'delete' && current.document.deletedAt !== null) || (operation.action === 'restore' && current.document.deletedAt === null));
      if (mismatch || invalidState) return this.remember(workspaceId, operation, hash, current
        ? { opId: operation.opId, status: 'conflict', entityId: operation.entityId, currentRevision: current.revision.toString(), document: current.document }
        : this.retired.has(entityKey) ? { opId: operation.opId, status: 'rejected', code: 'ID_RETIRED' } : { opId: operation.opId, status: 'rejected', code: 'ENTITY_NOT_FOUND' });
      const dependency = this.validateReferences(workspaceId, operation);
      if (dependency) return this.remember(workspaceId, operation, hash, { opId: operation.opId, status: 'rejected', code: dependency });
      const revision = (current?.revision ?? 0n) + 1n; const document = acceptedDocument(operation, { actorId, revision, now: new Date(), isNew: !current });
      this.entities.set(entityKey, { revision, document }); if (operation.action === 'delete') this.retired.add(entityKey);
      const events = this.events.get(workspaceId) ?? []; this.events.set(workspaceId, events); const cursor = BigInt(events.length + 1);
      const result: SyncResult = { opId: operation.opId, status: 'accepted', entityId: operation.entityId, revision: revision.toString(), cursor: cursor.toString() };
      this.remember(workspaceId, operation, hash, result); events.push({ cursor, operation, revision, document });
      const versions = this.revisionsByEntity.get(entityKey) ?? []; versions.push({ revision, action: operation.action, document }); this.revisionsByEntity.set(entityKey, versions); return result;
    });
  }
  async pull(workspaceId: string, cursor: string, limit: number): Promise<SyncPullResponse> {
    const after = BigInt(cursor); if (after < (this.minCursor.get(workspaceId) ?? 0n)) throw new AppError(410, 'CURSOR_EXPIRED', 'Cursor fora da janela de retenção.', { restartBootstrap: true });
    const pending = (this.events.get(workspaceId) ?? []).filter((event) => event.cursor > after); const changes = pending.slice(0, limit).map((event) => this.change(event));
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor, hasMore: pending.length > limit };
  }
  async bootstrap(workspaceId: string, limit: number): Promise<SyncBootstrapResponse> { return this.exclusive(async () => {
    const documents = [...this.entities.entries()].filter(([key]) => key.startsWith(`${workspaceId}:`)).map(([key, entity]) => { const [, entityType, entityId] = key.split(':'); return { entityType: entityType as SyncOperation['entityType'], entityId: entityId!, revision: entity.revision.toString(), document: structuredClone(entity.document) }; });
    const token = randomUUID(); this.snapshots.set(token, { cutCursor: BigInt((this.events.get(workspaceId) ?? []).length), documents, expiresAt: Date.now() + 600_000 }); return this.snapshotPage(token, 0n, limit);
  }); }
  async bootstrapPage(_workspaceId: string, token: string, cursor: string, limit: number): Promise<SyncBootstrapResponse> { const snapshot = this.snapshots.get(token); if (!snapshot || snapshot.expiresAt < Date.now()) throw new AppError(410, 'BOOTSTRAP_EXPIRED', 'Fotografia expirada; reinicie o bootstrap.'); return this.snapshotPage(token, BigInt(cursor), limit); }
  async get(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string) { const entity = this.entities.get(this.entityKey(workspaceId, entityType, entityId)); return entity ? { revision: entity.revision.toString(), document: entity.document } : null; }
  async list(workspaceId: string, entityType: SyncOperation['entityType'], limit: number) { return [...this.entities.entries()].filter(([key, value]) => key.startsWith(`${workspaceId}:${entityType}:`) && !value.document.deletedAt).slice(0, limit).map(([, value]) => ({ revision: value.revision.toString(), document: value.document })); }
  async revisions(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string, limit: number) { return (this.revisionsByEntity.get(this.entityKey(workspaceId, entityType, entityId)) ?? []).slice(-limit).reverse().map((item) => ({ revision: item.revision.toString(), action: item.action, document: item.document })); }
  private validateReferences(workspaceId: string, operation: SyncOperation): 'DEPENDENCY_NOT_READY' | undefined {
    if (!['create', 'update', 'restore'].includes(operation.action)) return undefined;
    const live = (type: SyncOperation['entityType'], id: string) => { const entity = this.entities.get(this.entityKey(workspaceId, type, id)); return !!entity && !entity.document.deletedAt; };
    const p = operation.payload as Record<string, unknown>; const theme = p.themeRef as { kind?: string; themeId?: string } | null | undefined;
    if (theme?.kind === 'workspace' && (!theme.themeId || !live('theme', theme.themeId))) return 'DEPENDENCY_NOT_READY';
    if (operation.entityType === 'arrangement') { if (!live('song', p.songId as string)) return 'DEPENDENCY_NOT_READY'; for (const binding of p.audioBindings as { assetId: string }[]) if (!live('asset', binding.assetId)) return 'DEPENDENCY_NOT_READY'; }
    if (operation.entityType === 'setlist') for (const item of p.items as { arrangementId: string }[]) if (!live('arrangement', item.arrangementId)) return 'DEPENDENCY_NOT_READY'; return undefined;
  }
  private touchDevice(workspaceId: string, deviceId: string) { const key = `${workspaceId}:${deviceId}`; const lastSeen = this.devices.get(key); if (lastSeen !== undefined && lastSeen < Date.now() - 180 * 24 * 60 * 60_000) throw new AppError(410, 'DEVICE_EXPIRED', 'Dispositivo fora da janela de reconciliação.', { restartBootstrap: true }); this.devices.set(key, Date.now()); }
  private snapshotPage(token: string, cursor: bigint, limit: number): SyncBootstrapResponse { const snapshot = this.snapshots.get(token)!; const start = Number(cursor); const documents = snapshot.documents.slice(start, start + limit); const next = BigInt(start + documents.length); return { token, accessRevision: '0', cutCursor: snapshot.cutCursor.toString(), documents, nextCursor: next.toString(), hasMore: Number(next) < snapshot.documents.length }; }
  private change(event: Event) { return { cursor: event.cursor.toString(), entityType: event.operation.entityType, entityId: event.operation.entityId, revision: event.revision.toString(), action: event.operation.action, document: event.document }; }
  private entityKey(workspaceId: string, type: string, id: string) { return `${workspaceId}:${type}:${id}`; }
  private remember(workspaceId: string, operation: SyncOperation, hash: string, result: SyncResult) { this.operations.set(`${workspaceId}:${operation.opId}`, { hash, result }); return result; }
  private async exclusive<T>(work: () => Promise<T> | T): Promise<T> { let release!: () => void; const previous = this.tail; this.tail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
}
