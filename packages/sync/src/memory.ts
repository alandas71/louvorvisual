import type { AssetBytes, AssetDoc, ArchiveEntry, ConflictRecord, EntityState, QueuedOperation, StagedDocument, SyncDoc, SyncEntityType, SyncMeta, SyncStorage, SyncTx } from './types';
import { entityKey } from './types';

type Data = {
  states: Map<string, EntityState>;
  documents: Map<string, SyncDoc>;
  operations: Map<string, QueuedOperation>;
  conflicts: Map<string, ConflictRecord>;
  staged: Map<string, StagedDocument>;
  archive: ArchiveEntry[];
  held: Set<string>;
  meta: SyncMeta;
};

/**
 * Armazenamento em memória com as mesmas garantias exigidas dos adaptadores
 * reais (IndexedDB, Room): transações em série e sem escrita parcial. Serve de
 * referência do contrato e de base para os testes do coordenador.
 */
export class MemorySyncStorage implements SyncStorage {
  private data: Data;
  private tail: Promise<unknown> = Promise.resolve();
  /** Chamado ao fim de cada transação confirmada, para simular falhas e observar gravações. */
  onCommit: (() => void) | null = null;

  constructor(deviceId: string) {
    this.data = { states: new Map(), documents: new Map(), operations: new Map(), conflicts: new Map(), staged: new Map(), archive: [], held: new Set(), meta: { key: 'sync', cursor: null, needsBootstrap: false, deviceId, suspended: null, lastSyncAt: null } };
  }

  get archived(): readonly ArchiveEntry[] {
    return this.data.archive;
  }

  /** Simula um editor aberto no documento. */
  hold(key: string, held = true): void {
    if (held) this.data.held.add(key);
    else this.data.held.delete(key);
  }

  transaction<T>(work: (tx: SyncTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.data);
      const result = await work(this.tx(draft));
      this.data = draft;
      this.onCommit?.();
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Edição local, como o repositório do aplicativo faz: documento e pendência juntos, geração + 1. */
  saveLocal(entityType: SyncEntityType, document: SyncDoc): Promise<number> {
    return this.transaction(async (tx) => {
      const key = entityKey(entityType, document.id);
      const previous = await tx.getState(key);
      const state: EntityState = {
        key,
        entityType,
        entityId: document.id,
        workspaceId: document.workspaceId,
        serverRevision: previous?.serverRevision ?? null,
        localGeneration: (previous?.localGeneration ?? 0) + 1,
        dirty: 1,
        lastAckSnapshot: previous?.lastAckSnapshot ?? null,
        conflict: previous?.conflict ?? null,
        deferredRemote: previous?.deferredRemote ?? null,
        blocked: previous?.blocked ?? null,
        updatedAt: document.updatedAt,
      };
      await tx.putDocument(entityType, document);
      await tx.putState(state);
      return state.localGeneration;
    });
  }

  private tx(data: Data): SyncTx {
    const copy = <T>(value: T): T => structuredClone(value);
    return {
      getState: async (key) => copy(data.states.get(key)),
      putState: async (state) => void data.states.set(state.key, copy(state)),
      listStates: async () => copy([...data.states.values()]),
      listDirtyStates: async () => copy([...data.states.values()].filter((state) => state.dirty === 1)),
      getDocument: async (entityType, entityId) => copy(data.documents.get(entityKey(entityType, entityId))),
      putDocument: async (entityType, document) => void data.documents.set(entityKey(entityType, document.id), copy(document)),
      listDocuments: async (entityType) => copy([...data.documents.entries()].filter(([key]) => key.startsWith(`${entityType}:`)).map(([, document]) => document)),
      listOperations: async () => copy([...data.operations.values()]),
      getOperationByKey: async (key) => copy([...data.operations.values()].find((operation) => operation.key === key)),
      putOperation: async (operation) => void data.operations.set(operation.opId, copy(operation)),
      deleteOperation: async (opId) => void data.operations.delete(opId),
      getConflict: async (id) => copy(data.conflicts.get(id)),
      putConflict: async (conflict) => void data.conflicts.set(conflict.id, copy(conflict)),
      listConflicts: async () => copy([...data.conflicts.values()]),
      getMeta: async () => copy(data.meta),
      putMeta: async (meta) => void (data.meta = copy(meta)),
      archive: async (entry) => void data.archive.push(copy(entry)),
      isHeld: async (key) => data.held.has(key),
      clearStaging: async () => data.staged.clear(),
      putStaged: async (documents) => {
        for (const document of documents) data.staged.set(entityKey(document.entityType, document.entityId), copy(document));
      },
      listStaged: async () => copy([...data.staged.values()]),
    };
  }
}

/** Bytes em memória, conferidos pelo tamanho; os adaptadores reais conferem também o hash. */
export class MemoryAssetBytes implements AssetBytes {
  readonly blobs = new Map<string, Blob>();
  async read(asset: AssetDoc): Promise<Blob | null> {
    return this.blobs.get(asset.sha256) ?? null;
  }
  async has(asset: AssetDoc): Promise<boolean> {
    return this.blobs.has(asset.sha256);
  }
  async write(asset: AssetDoc, blob: Blob): Promise<'stored' | 'mismatch'> {
    if (blob.size !== asset.byteSize) return 'mismatch';
    this.blobs.set(asset.sha256, blob);
    return 'stored';
  }
}
