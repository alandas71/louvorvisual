import { entityKey, type ConflictRecord, type ConflictResolution, type EntityState, type SyncDoc, type SyncEntityType, type SyncStorage, type SyncTx } from './types';

export class ConflictResolutionError extends Error {
  constructor(readonly code: 'not-open' | 'not-allowed') {
    super(code === 'not-open' ? 'Este conflito já foi resolvido.' : 'Esta opção não se aplica a este conflito.');
    this.name = 'ConflictResolutionError';
  }
}

type Deps = { storage: SyncStorage; now: () => string };
type Open = { conflict: ConflictRecord; state: EntityState; local: SyncDoc };

async function open(tx: SyncTx, conflictId: string): Promise<Open> {
  const conflict = await tx.getConflict(conflictId);
  const state = conflict && (await tx.getState(conflict.key));
  if (!conflict || conflict.status !== 'open' || !state || state.conflict !== conflict.id) throw new ConflictResolutionError('not-open');
  const local = (await tx.getDocument(conflict.entityType, conflict.entityId)) ?? conflict.local;
  return { conflict, state, local };
}

function close(tx: SyncTx, conflict: ConflictRecord, resolution: ConflictResolution, now: string): Promise<void> {
  return tx.putConflict({ ...conflict, status: 'resolved', resolution, resolvedAt: now });
}

/** Adota o remoto como base limpa; a variante local fica arquivada e recuperável. */
async function adoptRemote({ conflict, state, local }: Open, tx: SyncTx, now: string): Promise<void> {
  await tx.archive({ entityType: conflict.entityType, entityId: conflict.entityId, workspaceId: conflict.workspaceId, reason: 'conflict-local', document: local, createdAt: now });
  await tx.putDocument(conflict.entityType, conflict.remote);
  await tx.putState({
    ...state,
    serverRevision: conflict.remoteRevision,
    lastAckSnapshot: conflict.remote,
    // A geração avança para que nenhuma confirmação antiga case com este conteúdo.
    localGeneration: state.localGeneration + 1,
    dirty: 0,
    conflict: null,
    deferredRemote: null,
    blocked: null,
    updatedAt: now,
  });
}

/** "Manter remoto": arquiva a versão local e adota a remota. */
export function resolveKeepRemote(deps: Deps, conflictId: string): Promise<void> {
  return deps.storage.transaction(async (tx) => {
    const current = await open(tx, conflictId);
    const now = deps.now();
    await adoptRemote(current, tx, now);
    await close(tx, current.conflict, 'keep-remote', now);
  });
}

/**
 * "Manter minha versão" (ou o resultado de "Combinar", quando `merged` é
 * informado): arquiva o remoto e deixa a versão local pendente **sobre a
 * revisão remota atual**. O envio continua passando pelo controle de revisão:
 * se outra edição chegar antes, o servidor responde conflito e ele reabre.
 */
export function resolveKeepLocal(deps: Deps, conflictId: string, merged?: SyncDoc): Promise<void> {
  return deps.storage.transaction(async (tx) => {
    const { conflict, state, local } = await open(tx, conflictId);
    // Um ID excluído no servidor não é ressuscitado por um envio antigo.
    if (conflict.kind === 'remote-deleted') throw new ConflictResolutionError('not-allowed');
    const now = deps.now();
    await tx.archive({ entityType: conflict.entityType, entityId: conflict.entityId, workspaceId: conflict.workspaceId, reason: 'conflict-remote', document: conflict.remote, createdAt: now });
    if (merged) {
      if (merged.id !== conflict.entityId || merged.workspaceId !== conflict.workspaceId) throw new ConflictResolutionError('not-allowed');
      await tx.archive({ entityType: conflict.entityType, entityId: conflict.entityId, workspaceId: conflict.workspaceId, reason: 'conflict-local', document: local, createdAt: now });
      await tx.putDocument(conflict.entityType, merged);
    }
    await tx.putState({
      ...state,
      serverRevision: conflict.remoteRevision,
      lastAckSnapshot: conflict.remote,
      localGeneration: state.localGeneration + 1,
      dirty: 1,
      conflict: null,
      deferredRemote: null,
      blocked: null,
      updatedAt: now,
    });
    await close(tx, conflict, merged ? 'merged' : 'keep-local', now);
  });
}

export type AlternativeCopy = { entityType: SyncEntityType; document: SyncDoc };

/**
 * "Criar alternativa": a variante local vira registros novos, com novos IDs
 * montados por `copy`, e o registro original adota o remoto.
 */
export function resolveAlternative(deps: Deps, conflictId: string, copy: (local: SyncDoc) => readonly AlternativeCopy[]): Promise<AlternativeCopy[]> {
  return deps.storage.transaction(async (tx) => {
    const current = await open(tx, conflictId);
    const now = deps.now();
    const copies = [...copy(current.local)];
    for (const { entityType, document } of copies) {
      const key = entityKey(entityType, document.id);
      if (document.id === current.conflict.entityId || (await tx.getState(key))) throw new ConflictResolutionError('not-allowed');
      await tx.putDocument(entityType, document);
      await tx.putState({ key, entityType, entityId: document.id, workspaceId: document.workspaceId, serverRevision: null, localGeneration: 1, dirty: 1, lastAckSnapshot: null, conflict: null, updatedAt: now });
    }
    await adoptRemote(current, tx, now);
    await close(tx, current.conflict, 'alternative', now);
    return copies;
  });
}

/**
 * Carrega a versão remota recebida enquanto o editor estava aberto. Só vale
 * para documento sem alteração local; com alteração, o caminho é o conflito.
 */
export function adoptDeferredRemote(deps: Deps, key: string): Promise<boolean> {
  return deps.storage.transaction(async (tx) => {
    const state = await tx.getState(key);
    if (!state?.deferredRemote || state.dirty === 1 || state.conflict) return false;
    const operation = await tx.getOperationByKey(key);
    if (operation) return false;
    const { document, revision } = state.deferredRemote;
    await tx.putDocument(state.entityType, document);
    await tx.putState({ ...state, serverRevision: revision, lastAckSnapshot: document, deferredRemote: null, updatedAt: deps.now() });
    return true;
  });
}
