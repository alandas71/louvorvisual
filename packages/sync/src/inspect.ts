import { dependenciesOf, documentTitle } from './compare';
import type { AssetDoc, ConflictRecord, PendingItem, PendingPhase, SyncStorage, SyncSummary } from './types';

/** Pendências deste perfil, uma por documento, com o motivo de ainda não estarem confirmadas. */
export function listPending(storage: SyncStorage, now: string): Promise<PendingItem[]> {
  return storage.transaction(async (tx) => {
    const items: PendingItem[] = [];
    for (const state of await tx.listDirtyStates()) {
      const document = await tx.getDocument(state.entityType, state.entityId);
      if (!document) continue;
      const operation = await tx.getOperationByKey(state.key);
      let phase: PendingPhase = 'queued';
      let code: string | null = null;
      if (state.conflict) phase = 'conflict';
      else if (operation?.status === 'expired') phase = 'expired';
      else if (operation?.status === 'suspended') phase = 'suspended';
      else if (operation && operation.firstSentAt !== null) phase = 'sending';
      else if (state.blocked && state.blocked.generation === state.localGeneration && (state.blocked.retryAt === null || state.blocked.retryAt > now)) {
        phase = state.blocked.retryAt === null ? 'blocked' : 'waiting-dependency';
      } else if (state.entityType === 'asset' && (document as AssetDoc).remoteState !== 'ready' && document.deletedAt === null) phase = 'waiting-upload';
      else if (document.deletedAt === null) {
        for (const dependency of dependenciesOf(state.entityType, document)) {
          const dependencyState = await tx.getState(dependency);
          if (!dependencyState || dependencyState.serverRevision === null) phase = 'waiting-dependency';
        }
      }
      if (phase === 'blocked' || phase === 'waiting-dependency') code = state.blocked?.code ?? null;
      if (phase === 'suspended' || phase === 'expired' || phase === 'sending') code = operation?.lastError ?? null;
      items.push({
        key: state.key,
        entityType: state.entityType,
        entityId: state.entityId,
        title: documentTitle(document),
        phase,
        localGeneration: state.localGeneration,
        serverRevision: state.serverRevision,
        action: operation?.action ?? null,
        opId: operation?.opId ?? null,
        attempts: operation?.attempts ?? 0,
        code,
        deleted: document.deletedAt !== null,
      });
    }
    return items.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') || a.key.localeCompare(b.key));
  });
}

export function listOpenConflicts(storage: SyncStorage): Promise<ConflictRecord[]> {
  return storage.transaction(async (tx) => (await tx.listConflicts()).filter((conflict) => conflict.status === 'open').sort((a, b) => a.detectedAt.localeCompare(b.detectedAt)));
}

export function summarize(storage: SyncStorage): Promise<SyncSummary> {
  return storage.transaction(async (tx) => {
    const dirty = await tx.listDirtyStates();
    const operations = await tx.listOperations();
    const meta = await tx.getMeta();
    return {
      pending: dirty.length,
      conflicts: dirty.filter((state) => state.conflict).length,
      inTransit: operations.filter((operation) => operation.firstSentAt !== null && operation.status === 'queued').length,
      blocked: dirty.filter((state) => state.blocked?.generation === state.localGeneration && state.blocked.retryAt === null).length,
      cursor: meta.cursor,
      lastSyncAt: meta.lastSyncAt,
      suspended: meta.suspended,
    };
  });
}
