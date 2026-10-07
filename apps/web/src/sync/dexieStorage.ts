import { buildSongSearchEntry, type Arrangement, type Asset, type Setlist, type Song, type Theme } from '@louvorvisual/domain';
import type { ArchiveEntry, ConflictRecord, EntityState, QueuedOperation, StagedDocument, SyncDoc, SyncEntityType, SyncMeta, SyncStorage, SyncTx } from '@louvorvisual/sync';
import { entityKey } from '@louvorvisual/sync';
import Dexie, { type Table } from 'dexie';
import type { LocalDatabase } from '@/local/db';
import type { LocalRevision } from '@/local/schema';
import { LEASE_GRACE_MS, liveEditHolders } from './leases';

/**
 * Armazenamento do coordenador sobre o banco local (Dexie/IndexedDB). Cada
 * transação cobre documentos, situação local, fila, conflitos e cursor: ou
 * tudo fica gravado, ou nada muda. Só há operações de banco aqui dentro.
 */
export class DexieSyncStorage implements SyncStorage {
  constructor(
    private readonly db: LocalDatabase,
    private readonly scope: { workspaceId: string; deviceId: string },
  ) {}

  async transaction<T>(work: (tx: SyncTx) => Promise<T>): Promise<T> {
    const { db } = this;
    // Consulta feita antes da transação: dentro dela só cabem operações do banco.
    const live = await liveEditHolders();
    const liveAt = Date.now();
    // Sempre uma transação de topo: o coordenador encadeia transações com
    // chamadas de rede entre elas, e nenhuma pode herdar a zona de outra já
    // encerrada (o Dexie a trataria como subtransação de algo já confirmado).
    return Dexie.ignoreTransaction(() =>
      db.transaction(
        'rw',
        [db.songs, db.songIndex, db.arrangements, db.setlists, db.assets, db.themes, db.entityStates, db.revisions, db.syncOperations, db.syncConflicts, db.syncMeta, db.syncStaging, db.editLeases],
        // Precisa ser uma função `async`: é assim que o Dexie reconhece o escopo
        // e mantém a transação viva entre os `await` do coordenador.
        async () => work(this.tx(live, liveAt)),
      ),
    );
  }

  private table(entityType: SyncEntityType): Table<SyncDoc, string> {
    const { db } = this;
    const tables = { song: db.songs, arrangement: db.arrangements, setlist: db.setlists, asset: db.assets, theme: db.themes };
    return tables[entityType] as unknown as Table<SyncDoc, string>;
  }

  private tx(live: Set<string> | null, liveAt: number): SyncTx {
    const { db, scope } = this;
    return {
      getState: (key) => db.entityStates.get(key),
      putState: async (state: EntityState) => void (await db.entityStates.put(state)),
      listStates: () => db.entityStates.toArray(),
      listDirtyStates: () => db.entityStates.where('[workspaceId+dirty]').equals([scope.workspaceId, 1]).toArray(),
      getDocument: (entityType, entityId) => this.table(entityType).get(entityId),
      putDocument: async (entityType, document) => {
        await this.table(entityType).put(document);
        // O índice de busca é derivado do louvor e muda junto com ele.
        if (entityType === 'song') await db.songIndex.put(buildSongSearchEntry(document as Song));
      },
      listDocuments: (entityType) => this.table(entityType).toArray(),
      listOperations: () => db.syncOperations.toArray(),
      getOperationByKey: (key) => db.syncOperations.where('key').equals(key).first(),
      putOperation: async (operation: QueuedOperation) => void (await db.syncOperations.put(operation)),
      deleteOperation: (opId) => db.syncOperations.delete(opId),
      getConflict: (id) => db.syncConflicts.get(id),
      putConflict: async (conflict: ConflictRecord) => void (await db.syncConflicts.put(conflict)),
      listConflicts: () => db.syncConflicts.toArray(),
      getMeta: async () => (await db.syncMeta.get('sync')) ?? { key: 'sync', cursor: null, needsBootstrap: false, deviceId: scope.deviceId, suspended: null, lastSyncAt: null },
      putMeta: async (meta: SyncMeta) => void (await db.syncMeta.put(meta)),
      archive: async (entry: ArchiveEntry) => {
        const revision: LocalRevision = { id: crypto.randomUUID(), ...entry, document: entry.document as Song | Arrangement | Setlist | Asset | Theme };
        await db.revisions.put(revision);
      },
      // Vale a marcação cuja janela ainda existe, pela trava que ela mantém — mesmo
      // com a validade vencida: em segundo plano ou após suspensão o navegador
      // atrasa os timers de renovação, e o editor continua com o documento em
      // memória. A validade só decide quando o navegador não informa as travas.
      // A criada logo antes da consulta vale de qualquer forma (ver LEASE_GRACE_MS).
      isHeld: async (key) => {
        const now = Date.now();
        return (await db.editLeases.where('key').equals(key).toArray()).some((lease) =>
          live === null ? lease.expiresAt > now : live.has(lease.holder) || (lease.createdAt ?? 0) > liveAt - LEASE_GRACE_MS,
        );
      },
      clearStaging: () => db.syncStaging.clear(),
      putStaged: async (documents: readonly StagedDocument[]) => void (await db.syncStaging.bulkPut(documents.map((document) => ({ ...document, key: entityKey(document.entityType, document.entityId) })))),
      listStaged: async () => (await db.syncStaging.toArray()).map(({ entityType, entityId, revision, document }) => ({ entityType, entityId, revision, document })),
    };
  }
}
