import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { SyncBootstrapResponse, SyncOperation, SyncPullResponse, SyncResult } from '@louvorvisual/contracts';
import { AppError } from '../../utils/AppError';
import { acceptedDocument, operationHash, type SyncDocument, type SyncStore } from './sync-store';

const decodeDocument = (value: string) => JSON.parse(value) as SyncDocument;
const decodeResult = (value: string) => JSON.parse(value) as SyncResult;
const TRANSIENT_CODES = new Set(['P2034', 'P2028']); const MAX_ATTEMPTS = 4;
type Tx = Prisma.TransactionClient;

/**
 * O lock UPDLOCK da clock row serializa toda mutação compartilhada do espaço.
 * Portanto entidade, revisão recuperável, opId e evento/cursor confirmam juntos.
 */
export class PrismaSyncStore implements SyncStore {
  constructor(private readonly prisma: PrismaClient) {}
  async ensureWorkspace(workspace: { id: string; name: string; timezone: string }): Promise<void> {
    await this.prisma.workspace.upsert({ where: { id: workspace.id }, create: { ...workspace, syncClock: { create: {} } }, update: { name: workspace.name, timezone: workspace.timezone } });
  }
  async apply(workspaceId: string, actorId: string, operation: SyncOperation, deviceId?: string): Promise<SyncResult> {
    for (let attempt = 1; ; attempt++) try { return await this.applyOnce(workspaceId, actorId, operation, deviceId); } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_CODES.has(error.code)) || attempt === MAX_ATTEMPTS) throw error;
    }
  }
  private applyOnce(workspaceId: string, actorId: string, operation: SyncOperation, deviceId?: string): Promise<SyncResult> {
    const hash = operationHash(operation);
    return this.prisma.$transaction(async (tx) => {
      await this.lockClock(tx, workspaceId);
      if (deviceId) await this.touchDevice(tx, workspaceId, actorId, deviceId);
      const existing = await tx.processedOperation.findUnique({ where: { workspaceId_opId: { workspaceId, opId: operation.opId } } });
      if (existing) { if (existing.payloadHash !== hash) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'opId já foi usado com outro payload.'); return decodeResult(existing.resultJson); }
      const key = { workspaceId_entityType_entityId: { workspaceId, entityType: operation.entityType, entityId: operation.entityId } };
      const current = await tx.contentEntity.findUnique({ where: key });
      const mismatch = (operation.action === 'create' && current) || (operation.action !== 'create' && (!current || current.currentRevision.toString() !== operation.baseRevision));
      const invalidState = !!current && ((operation.action === 'update' && current.deletedAt !== null) || (operation.action === 'delete' && current.deletedAt !== null) || (operation.action === 'restore' && current.deletedAt === null));
      if (mismatch || invalidState) {
        let result: SyncResult;
        if (current) result = { opId: operation.opId, status: 'conflict', entityId: operation.entityId, currentRevision: current.currentRevision.toString(), document: decodeDocument(current.documentJson) };
        else if (await tx.retiredEntityId.findUnique({ where: key })) result = { opId: operation.opId, status: 'rejected', code: 'ID_RETIRED' };
        else result = { opId: operation.opId, status: 'rejected', code: 'ENTITY_NOT_FOUND' };
        return this.remember(tx, workspaceId, actorId, operation.opId, hash, result);
      }
      const dependency = await this.validateReferences(tx, workspaceId, operation);
      if (dependency) return this.remember(tx, workspaceId, actorId, operation.opId, hash, { opId: operation.opId, status: 'rejected', code: dependency });
      const revision = (current?.currentRevision ?? 0n) + 1n; const now = new Date(); const document = acceptedDocument(operation, { actorId, revision, now, isNew: !current }); const documentJson = JSON.stringify(document); const deletedAt = document.deletedAt ? new Date(document.deletedAt) : null;
      if (current) await tx.contentEntity.update({ where: key, data: { currentRevision: revision, documentJson, deletedAt, updatedAt: now } });
      else await tx.contentEntity.create({ data: { workspaceId, entityType: operation.entityType, entityId: operation.entityId, currentRevision: revision, documentJson, deletedAt, updatedAt: now } });
      if (operation.action === 'delete') await tx.retiredEntityId.upsert({ where: key, create: { workspaceId, entityType: operation.entityType, entityId: operation.entityId }, update: {} });
      await tx.contentRevision.create({ data: { workspaceId, entityType: operation.entityType, entityId: operation.entityId, revision, documentJson, action: operation.action, actorId } });
      const advanced = await tx.workspaceSyncClock.update({ where: { workspaceId }, data: { nextCursor: { increment: 1 } }, select: { nextCursor: true } });
      await tx.changeEvent.create({ data: { workspaceId, cursor: advanced.nextCursor, entityType: operation.entityType, entityId: operation.entityId, revision, action: operation.action } });
      return this.remember(tx, workspaceId, actorId, operation.opId, hash, { opId: operation.opId, status: 'accepted', entityId: operation.entityId, revision: revision.toString(), cursor: advanced.nextCursor.toString() });
    }, { maxWait: 10_000, timeout: 15_000 });
  }
  async pull(workspaceId: string, cursor: string, limit: number): Promise<SyncPullResponse> {
    const after = BigInt(cursor); const clock = await this.prisma.workspaceSyncClock.findUnique({ where: { workspaceId } }); if (!clock) throw new AppError(404, 'NOT_FOUND', 'Espaço de trabalho não encontrado.');
    if (after < clock.minCursor) throw new AppError(410, 'CURSOR_EXPIRED', 'Cursor fora da janela de retenção.', { restartBootstrap: true });
    const events = await this.prisma.changeEvent.findMany({ where: { workspaceId, cursor: { gt: after } }, orderBy: { cursor: 'asc' }, take: limit + 1 }); const page = events.slice(0, limit);
    const changes = await Promise.all(page.map(async (event) => { const revision = await this.prisma.contentRevision.findUniqueOrThrow({ where: { workspaceId_entityType_entityId_revision: { workspaceId, entityType: event.entityType, entityId: event.entityId, revision: event.revision } } }); return { cursor: event.cursor.toString(), entityType: event.entityType as SyncOperation['entityType'], entityId: event.entityId, revision: event.revision.toString(), action: event.action as SyncOperation['action'], document: decodeDocument(revision.documentJson) }; }));
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor, hasMore: events.length > limit };
  }
  async bootstrap(workspaceId: string, limit: number): Promise<SyncBootstrapResponse> {
    return this.prisma.$transaction(async (tx) => {
      const clock = await this.lockClock(tx, workspaceId); const entities = await tx.contentEntity.findMany({ where: { workspaceId }, orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }] }); const token = randomUUID();
      await tx.syncBootstrapSnapshot.create({ data: { token, workspaceId, cutCursor: clock.nextCursor, documentsJson: JSON.stringify(entities.map((entity) => ({ entityType: entity.entityType, entityId: entity.entityId, revision: entity.currentRevision.toString(), document: decodeDocument(entity.documentJson) }))), expiresAt: new Date(Date.now() + 600_000) } });
      return this.bootstrapPageTx(tx, workspaceId, token, 0, limit);
    });
  }
  async bootstrapPage(workspaceId: string, token: string, cursor: string, limit: number): Promise<SyncBootstrapResponse> { return this.prisma.$transaction((tx) => this.bootstrapPageTx(tx, workspaceId, token, Number(BigInt(cursor)), limit)); }
  async get(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string) { const entity = await this.prisma.contentEntity.findUnique({ where: { workspaceId_entityType_entityId: { workspaceId, entityType, entityId } } }); return entity ? { revision: entity.currentRevision.toString(), document: decodeDocument(entity.documentJson) } : null; }
  async list(workspaceId: string, entityType: SyncOperation['entityType'], limit: number) { const entities = await this.prisma.contentEntity.findMany({ where: { workspaceId, entityType, deletedAt: null }, take: limit, orderBy: { updatedAt: 'desc' } }); return entities.map((entity) => ({ revision: entity.currentRevision.toString(), document: decodeDocument(entity.documentJson) })); }
  async revisions(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string, limit: number) { const rows = await this.prisma.contentRevision.findMany({ where: { workspaceId, entityType, entityId }, take: limit, orderBy: { revision: 'desc' } }); return rows.map((row) => ({ revision: row.revision.toString(), action: row.action as SyncOperation['action'], document: decodeDocument(row.documentJson) })); }
  private async lockClock(tx: Tx, workspaceId: string) { const locks = await tx.$queryRaw<{ workspaceId: string }[]>`SELECT [workspaceId] FROM [dbo].[workspace_sync_clocks] WITH (UPDLOCK, ROWLOCK) WHERE [workspaceId] = ${workspaceId}`; if (!locks.length) throw new AppError(404, 'NOT_FOUND', 'Espaço de trabalho não encontrado.'); return tx.workspaceSyncClock.findUniqueOrThrow({ where: { workspaceId } }); }
  private async remember(tx: Tx, workspaceId: string, actorId: string, opId: string, payloadHash: string, result: SyncResult) { await tx.processedOperation.create({ data: { workspaceId, opId, actorId, payloadHash, resultJson: JSON.stringify(result) } }); return result; }
  private async validateReferences(tx: Tx, workspaceId: string, operation: SyncOperation): Promise<'DEPENDENCY_NOT_READY' | undefined> {
    if (!['create', 'update', 'restore'].includes(operation.action)) return undefined;
    const live = async (entityType: SyncOperation['entityType'], entityId: string) => !!await tx.contentEntity.findFirst({ where: { workspaceId, entityType, entityId, deletedAt: null } }); const p = operation.payload as Record<string, unknown>; const theme = p.themeRef as { kind?: string; themeId?: string } | null | undefined;
    if (theme?.kind === 'workspace' && (!theme.themeId || !await live('theme', theme.themeId))) return 'DEPENDENCY_NOT_READY';
    if (operation.entityType === 'arrangement') { if (!await live('song', p.songId as string)) return 'DEPENDENCY_NOT_READY'; for (const binding of p.audioBindings as { assetId: string }[]) { const synced = await live('asset', binding.assetId); const asset = synced || !!await tx.asset.findFirst({ where: { workspaceId, id: binding.assetId, state: 'ready' } }); if (!asset) return 'DEPENDENCY_NOT_READY'; } }
    if (operation.entityType === 'setlist') for (const item of p.items as { arrangementId: string }[]) if (!await live('arrangement', item.arrangementId)) return 'DEPENDENCY_NOT_READY'; return undefined;
  }
  private async touchDevice(tx: Tx, workspaceId: string, actorId: string, deviceId: string) { const device = await tx.device.findUnique({ where: { id: deviceId } }); const expired = Date.now() - 180 * 24 * 60 * 60_000; if (device && (device.workspaceId !== workspaceId || device.userId !== actorId || device.lastSeenAt.getTime() < expired)) throw new AppError(410, 'DEVICE_EXPIRED', 'Dispositivo fora da janela de reconciliação.', { restartBootstrap: true }); if (device) await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } }); else await tx.device.create({ data: { id: deviceId, workspaceId, userId: actorId } }); }
  private async bootstrapPageTx(tx: Tx, workspaceId: string, token: string, offset: number, limit: number): Promise<SyncBootstrapResponse> { const snapshot = await tx.syncBootstrapSnapshot.findFirst({ where: { token, workspaceId } }); if (!snapshot || snapshot.expiresAt < new Date()) throw new AppError(410, 'BOOTSTRAP_EXPIRED', 'Fotografia expirada; reinicie o bootstrap.'); const all = JSON.parse(snapshot.documentsJson) as SyncBootstrapResponse['documents']; const documents = all.slice(offset, offset + limit); const next = offset + documents.length; return { token, accessRevision: snapshot.accessRevision.toString(), cutCursor: snapshot.cutCursor.toString(), documents, nextCursor: String(next), hasMore: next < all.length }; }
}
