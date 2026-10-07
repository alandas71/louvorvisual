import type { Arrangement, Asset, AudioMimeType, IsoInstant, Setlist, Song, SongSearchEntry, Theme, Uuid } from '@louvorvisual/domain';
import type { Rotation, SessionCheckpoint, SessionSnapshot } from '@louvorvisual/presentation';
import type { ArchiveReason, ConflictRecord, EntityState, QueuedOperation, StagedDocument, SyncEntityType, SyncMeta } from '@louvorvisual/sync';

/** Nome fixo: IndexedDB pertence à origem, e trocar o nome abandonaria a biblioteca. */
export const LOCAL_DB_NAME = 'louvorvisual';
/** Versão atual do banco local; cada mudança de estrutura ganha uma versão e uma migração. */
export const LOCAL_DB_VERSION = 6;

/** Tipos de documento gravados nesta etapa. */
export type LocalEntityType = 'song' | 'arrangement' | 'setlist' | 'asset';

export type LocalDocument =
  | { entityType: 'song'; document: Song }
  | { entityType: 'arrangement'; document: Arrangement }
  | { entityType: 'setlist'; document: Setlist }
  | { entityType: 'asset'; document: Asset }
  // Tema da equipe: nesta etapa só entra por sincronização ou por pacote importado.
  | { entityType: 'theme'; document: Theme };

/**
 * Situação local de um documento (planejamento/11). `dirty` é 0/1 porque
 * IndexedDB não indexa booleanos. Gravado sempre na mesma transação do
 * documento. A definição é a do coordenador de sincronização, para que web e
 * Android apliquem as mesmas regras de geração, base e conflito.
 */
export type LocalEntityState = EntityState;

/**
 * Por que uma cópia foi guardada. `regenerate`, `edit`, `delete` e `restore`
 * vêm de ações locais (o estado de antes); `corrupted` é o registro ilegível
 * retirado por um reparo; as demais vêm da sincronização.
 */
export type RevisionReason = 'regenerate' | 'edit' | 'delete' | 'restore' | 'corrupted' | ArchiveReason;

/** Cópia recuperável de um documento antes de uma operação que o substitui. */
export type LocalRevision = {
  id: Uuid;
  entityType: SyncEntityType;
  entityId: Uuid;
  workspaceId: Uuid;
  createdAt: IsoInstant;
  reason: RevisionReason;
  /** Em `corrupted`, o registro como estava no banco, sem garantia de formato. */
  document: Song | Arrangement | Setlist | Asset | Theme;
};

/**
 * Para onde uma importação de pacote levou um registro de origem. Repetir a
 * importação consulta este mapa em vez de criar outra cópia.
 */
export type ImportMapRow = {
  /** `espaçoDeOrigem:tipo:idDeOrigem`. */
  key: string;
  entityType: SyncEntityType;
  originId: Uuid;
  localId: Uuid;
  packageId: Uuid;
  importedAt: IsoInstant;
};

/** Perfil pessoal deste dispositivo; o espaço local não é enviado sem importação explícita. */
export type LocalProfile = {
  key: 'profile';
  /** Ausente nos bancos criados antes da sincronização: equivale a `personal`. */
  kind?: 'personal' | 'team';
  profileId: Uuid;
  workspaceId: Uuid;
  userId: Uuid;
  deviceId: Uuid;
  createdAt: IsoInstant;
};

export type SongIndexRow = SongSearchEntry;

export function entityStateKey(entityType: SyncEntityType, entityId: Uuid): string {
  return `${entityType}:${entityId}`;
}

/**
 * Sessão de apresentação preparada neste dispositivo. O snapshot é a base
 * estável; `baseArrangement` é o arranjo como estava na preparação, usado para
 * comparar campos ao salvar ajustes de volta. Nada disso é sincronizado.
 */
export type PresentationSessionRow = {
  id: Uuid;
  workspaceId: Uuid;
  songId: Uuid;
  arrangementId: Uuid;
  status: 'active' | 'ended';
  createdAt: IsoInstant;
  snapshot: SessionSnapshot;
  baseArrangement: Arrangement;
};

/** Último checkpoint confirmado de uma sessão; substituído a cada gravação. */
export type PresentationCheckpointRow = {
  sessionId: Uuid;
  savedAt: IsoInstant;
  checkpoint: SessionCheckpoint;
};

/** Preferências de uma saída neste dispositivo; não pertencem ao tema nem ao arranjo. */
export type OutputPreferencesRow = {
  outputId: 'public';
  rotation: Rotation;
};

/** Chave dos bytes de um arquivo: privados por espaço, identificados pelo hash. */
export function assetBlobKey(workspaceId: Uuid, sha256: string): string {
  return `${workspaceId}:${sha256}`;
}

/**
 * Bytes locais de um arquivo de áudio (planejamento/11, `AssetBlob`). São
 * imutáveis e deduplicados pelo hash dentro do espaço. `staged` é uma escrita
 * ainda não conferida: nunca é tratada como arquivo disponível.
 */
export type AssetBlobRow = {
  key: string;
  profileId: Uuid;
  workspaceId: Uuid;
  sha256: string;
  byteSize: number;
  mimeType: AudioMimeType;
  blob: Blob;
  state: 'staged' | 'ready';
  storedAt: IsoInstant;
  verifiedAt: IsoInstant | null;
};

export type PackageProblemCode =
  | 'empty'
  | 'arrangement-missing'
  | 'song-missing'
  | 'snapshot-invalid'
  | 'asset-missing'
  | 'audio-missing'
  | 'audio-corrupted'
  | 'audio-unplayable'
  | 'font-missing';

/** O que impediu marcar o repertório como pronto, com o suficiente para o operador agir. */
export type PackageProblem = {
  code: PackageProblemCode;
  itemId?: Uuid;
  songId?: Uuid;
  arrangementId?: Uuid;
  /** Título do louvor, nome do arquivo de áudio ou da fonte. */
  subject?: string;
  filename?: string;
};

/** Dependência de áudio de um item: os bytes exatos que foram conferidos. */
export type PackageAudio = { bindingId: Uuid; assetId: Uuid; sha256: string; byteSize: number; filename: string };

/** Cópia preparada de um item: a apresentação usa esta base, não a biblioteca viva. */
export type OfflinePackageItem = {
  itemId: Uuid;
  arrangementId: Uuid;
  songId: Uuid;
  title: string;
  arrangementName: string;
  songGeneration: number;
  arrangementGeneration: number;
  snapshot: SessionSnapshot;
  baseArrangement: Arrangement;
  audio: PackageAudio | null;
};

/** Manifesto de uma preparação concluída: representa uma revisão específica do repertório. */
export type ReadyPackage = {
  preparedAt: IsoInstant;
  setlistGeneration: number;
  fontPackVersion: string;
  fonts: { file: string; sha256: string }[];
  items: OfflinePackageItem[];
};

/**
 * Preparação offline de um repertório (planejamento/08). `ready` só existe
 * depois de todas as escritas e conferências; uma tentativa que falha fica em
 * `lastAttempt` e não apaga a cópia pronta anterior.
 */
export type OfflinePackageRow = {
  setlistId: Uuid;
  workspaceId: Uuid;
  ready: ReadyPackage | null;
  lastAttempt: { at: IsoInstant; ok: boolean; problems: PackageProblem[] } | null;
};

/** Tentativa de envio persistida antes da requisição; nunca é regravada com outro conteúdo. */
export type SyncOperationRow = QueuedOperation;
export type SyncConflictRow = ConflictRecord;
export type SyncMetaRow = SyncMeta;
/** Página de bootstrap em área separada, até a fotografia inteira chegar. */
export type SyncStagingRow = StagedDocument & { key: string };

/**
 * Editor aberto em um documento, em alguma janela deste perfil. Enquanto o
 * registro estiver válido, o recebimento não troca o documento sob o editor.
 */
export type EditLeaseRow = { id: string; key: string; holder: string; expiresAt: number; createdAt?: number };
