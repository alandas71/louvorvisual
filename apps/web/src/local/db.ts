import { buildSongSearchEntry, type Arrangement, type Asset, type Setlist, type Song, type Theme } from '@louvorvisual/domain';
import Dexie, { type Table } from 'dexie';
import {
  LOCAL_DB_NAME,
  type AssetBlobRow,
  type EditLeaseRow,
  type ImportMapRow,
  type LocalEntityState,
  type LocalProfile,
  type LocalRevision,
  type OfflinePackageRow,
  type OutputPreferencesRow,
  type PresentationCheckpointRow,
  type PresentationSessionRow,
  type SongIndexRow,
  type SyncConflictRow,
  type SyncMetaRow,
  type SyncOperationRow,
  type SyncStagingRow,
} from './schema';

/** Transação de migração: só enxerga tabelas pelo nome, como estavam naquela versão. */
export type UpgradeTransaction = { table<T = unknown, K = string>(name: string): Table<T, K> };

/**
 * Conversões de dados por versão do banco. Cada uma roda dentro da transação
 * de troca de versão do IndexedDB: se falhar ou for interrompida (aba fechada,
 * queda de energia), o navegador desfaz tudo e o banco continua na versão
 * anterior, inteiro; a próxima abertura tenta de novo. Por isso nenhuma delas
 * usa rede, relógio de parede como dado ou qualquer coisa fora do banco.
 */
export const UPGRADES: Readonly<Record<number, (transaction: UpgradeTransaction) => Promise<void>>> = {
  // O índice de busca é derivado: é reconstruído a partir dos louvores já gravados.
  2: async (transaction) => {
    const songs = await transaction.table<Song>('songs').toArray();
    await transaction.table<SongIndexRow>('songIndex').bulkPut(songs.map(buildSongSearchEntry));
  },
  // Cópias guardadas antes de existir o índice por espaço: o espaço vem do próprio documento.
  6: async (transaction) => {
    await transaction
      .table<{ workspaceId?: string; document?: { workspaceId?: string } }>('revisions')
      .toCollection()
      .modify((revision) => {
        if (typeof revision.workspaceId !== 'string' && typeof revision.document?.workspaceId === 'string') revision.workspaceId = revision.document.workspaceId;
      });
  },
};

/**
 * Banco local (IndexedDB). As versões são incrementais e nunca reescritas:
 * uma instalação antiga passa por todas as migrações seguintes ao abrir.
 * Nenhuma migração apaga tabela ou documento; mudança destrutiva exigiria
 * exportação e caminho de volta testados antes (planejamento/08).
 */
export class LocalDatabase extends Dexie {
  songs!: Table<Song, string>;
  arrangements!: Table<Arrangement, string>;
  entityStates!: Table<LocalEntityState, string>;
  meta!: Table<LocalProfile, string>;
  songIndex!: Table<SongIndexRow, string>;
  revisions!: Table<LocalRevision, string>;
  presentationSessions!: Table<PresentationSessionRow, string>;
  presentationCheckpoints!: Table<PresentationCheckpointRow, string>;
  outputPreferences!: Table<OutputPreferencesRow, string>;
  assets!: Table<Asset, string>;
  assetBlobs!: Table<AssetBlobRow, string>;
  setlists!: Table<Setlist, string>;
  offlinePackages!: Table<OfflinePackageRow, string>;
  themes!: Table<Theme, string>;
  syncOperations!: Table<SyncOperationRow, string>;
  syncConflicts!: Table<SyncConflictRow, string>;
  syncMeta!: Table<SyncMetaRow, string>;
  syncStaging!: Table<SyncStagingRow, string>;
  editLeases!: Table<EditLeaseRow, string>;
  importMap!: Table<ImportMapRow, string>;

  /** `upgrades` só é trocado nos testes, para interromper uma migração no meio. */
  constructor(name: string = LOCAL_DB_NAME, upgrades: typeof UPGRADES = UPGRADES) {
    super(name);
    const upgrade = (version: number) => (transaction: UpgradeTransaction) => (upgrades[version] as (transaction: UpgradeTransaction) => Promise<void>)(transaction);

    // v1 — documentos, situação local e perfil.
    this.version(1).stores({
      songs: 'id, workspaceId',
      arrangements: 'id, workspaceId, songId',
      entityStates: 'key, [workspaceId+dirty]',
      meta: 'key',
    });

    // v2 — índice de busca normalizado e revisões recuperáveis. O índice é
    // derivado: a migração o reconstrói a partir dos louvores já gravados.
    this.version(2)
      .stores({
        songIndex: 'id, workspaceId',
        revisions: 'id, [entityType+entityId]',
      })
      .upgrade(upgrade(2));

    // v3 — sessões de apresentação: base preparada, checkpoint e preferências
    // da saída. Só tabelas novas; nenhum documento existente é tocado.
    this.version(3).stores({
      presentationSessions: 'id, [arrangementId+status]',
      presentationCheckpoints: 'sessionId',
      outputPreferences: 'outputId',
    });

    // v4 — áudio (metadados e bytes por hash), repertórios e preparação
    // offline. Só tabelas novas; arranjos já gravados continuam válidos.
    this.version(4).stores({
      assets: 'id, workspaceId, [workspaceId+sha256]',
      assetBlobs: 'key, workspaceId',
      setlists: 'id, workspaceId',
      offlinePackages: 'setlistId',
    });

    // v5 — sincronização: fila de tentativas, conflitos, cursor, área de
    // bootstrap, temas recebidos da equipe e editores abertos. Só tabelas
    // novas; a situação local já gravada continua válida (campos opcionais).
    this.version(5).stores({
      themes: 'id, workspaceId',
      syncOperations: 'opId, key',
      syncConflicts: 'id, key, status',
      syncMeta: 'key',
      syncStaging: 'key',
      editLeases: 'id, key',
    });

    // v6 — pacotes e histórico: mapa das importações e índice das cópias por
    // espaço (lixeira e histórico). Nenhum documento é tocado; as cópias
    // antigas só ganham o campo do índice.
    this.version(6)
      .stores({
        importMap: 'key',
        revisions: 'id, [entityType+entityId], workspaceId',
      })
      .upgrade(upgrade(6));
  }
}

let shared: LocalDatabase | null = null;

/** Conexão única do aplicativo; os testes criam instâncias próprias com outro nome. */
export function localDatabase(): LocalDatabase {
  shared ??= new LocalDatabase();
  return shared;
}
