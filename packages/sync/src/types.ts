import type { SyncBootstrapResponse, SyncEntityType, SyncOperation, SyncPullResponse, SyncResult } from '@louvorvisual/contracts';

export type { SyncEntityType };

/** Documento completo de um agregado, como trafega nos envelopes de sincronização. */
export type SyncDoc = SyncOperation['payload'];
export type SyncAction = SyncOperation['action'];

export function entityKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Ordem de envio (planejamento/09): arquivos, depois louvor e temas, arranjos e repertórios. */
export const ENTITY_ORDER: readonly SyncEntityType[] = ['asset', 'song', 'theme', 'arrangement', 'setlist'];

export type RemoteVersion = { revision: string; document: SyncDoc };

/** Envio recusado pelo servidor ou impossível neste dispositivo; `generation` é a geração recusada. */
export type BlockedState = {
  code: string;
  generation: number;
  /** Quando preenchido, a recusa é passageira e uma nova tentativa só é capturada depois deste instante. */
  retryAt: string | null;
  details?: unknown;
};

/**
 * Situação local de um documento (planejamento/11, `LocalEntityState`). É
 * gravada sempre na mesma transação do documento.
 */
export type EntityState = {
  /** `tipo:id`. */
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  workspaceId: string;
  /** Última revisão confirmada pelo servidor; `null` enquanto só existe aqui. */
  serverRevision: string | null;
  /** Cresce a cada gravação local; uma confirmação só limpa `dirty` da geração que capturou. */
  localGeneration: number;
  dirty: 0 | 1;
  /** Conteúdo reconhecido pelo servidor: a base das comparações. */
  lastAckSnapshot: SyncDoc | null;
  /** ID do conflito aberto, se houver. */
  conflict: string | null;
  updatedAt: string;
  /**
   * Versão remota recebida enquanto havia tentativa em trânsito ou editor
   * aberto. Nunca substitui o conteúdo local sozinha: é integrada depois.
   */
  deferredRemote?: RemoteVersion | null;
  blocked?: BlockedState | null;
};

/**
 * Tentativa lógica de envio (planejamento/09). Depois de gravada, `opId`,
 * `payload`, `action` e `baseRevision` nunca mudam: uma repetição envia
 * exatamente o mesmo conteúdo.
 */
export type QueuedOperation = {
  opId: string;
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  action: SyncAction;
  baseRevision: string;
  /** Geração local que este payload representa. */
  capturedGeneration: number;
  payload: SyncDoc;
  createdAt: string;
  attempts: number;
  /** `null` enquanto nunca saiu deste dispositivo; só então pode ser trocada por uma captura mais nova. */
  firstSentAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /**
   * `suspended`: erro de contrato, não é repetida. `expired`: a janela de
   * idempotência do dispositivo venceu; só sai por reconciliação explícita.
   */
  status: 'queued' | 'suspended' | 'expired';
};

export type ConflictKind = 'both-edited' | 'remote-deleted' | 'local-deleted';
export type ConflictResolution = 'keep-remote' | 'keep-local' | 'merged' | 'alternative';

export type ConflictRecord = {
  id: string;
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  workspaceId: string;
  kind: ConflictKind;
  /** Base conhecida pelas duas variantes; `null` se o registro nunca tinha sido confirmado. */
  base: SyncDoc | null;
  baseRevision: string | null;
  /** Variante local no momento da detecção; o documento vivo pode ter recebido edições depois. */
  local: SyncDoc;
  localGeneration: number;
  remote: SyncDoc;
  remoteRevision: string;
  detectedAt: string;
  status: 'open' | 'resolved';
  resolution: ConflictResolution | null;
  resolvedAt: string | null;
};

export type SuspensionCode = 'revoked' | 'read-only' | 'contract' | 'workspace-missing';

export type SyncMeta = {
  key: 'sync';
  /** Posição no log do espaço; `null` até o primeiro bootstrap terminar. */
  cursor: string | null;
  needsBootstrap: boolean;
  deviceId: string;
  suspended: { code: SuspensionCode; message: string; at: string } | null;
  lastSyncAt: string | null;
};

export type ArchiveReason = 'conflict-local' | 'conflict-remote' | 'bootstrap-missing';
export type ArchiveEntry = { entityType: SyncEntityType; entityId: string; workspaceId: string; reason: ArchiveReason; document: SyncDoc; createdAt: string };

export type StagedDocument = SyncBootstrapResponse['documents'][number];

/** Operações de banco de uma transação local. Nenhuma delas usa rede. */
export interface SyncTx {
  getState(key: string): Promise<EntityState | undefined>;
  putState(state: EntityState): Promise<void>;
  listStates(): Promise<EntityState[]>;
  listDirtyStates(): Promise<EntityState[]>;
  getDocument(entityType: SyncEntityType, entityId: string): Promise<SyncDoc | undefined>;
  /** Grava o documento como está; geração e pendência são responsabilidade de quem chama. */
  putDocument(entityType: SyncEntityType, document: SyncDoc): Promise<void>;
  listDocuments(entityType: SyncEntityType): Promise<SyncDoc[]>;
  listOperations(): Promise<QueuedOperation[]>;
  getOperationByKey(key: string): Promise<QueuedOperation | undefined>;
  putOperation(operation: QueuedOperation): Promise<void>;
  deleteOperation(opId: string): Promise<void>;
  getConflict(id: string): Promise<ConflictRecord | undefined>;
  putConflict(conflict: ConflictRecord): Promise<void>;
  listConflicts(): Promise<ConflictRecord[]>;
  getMeta(): Promise<SyncMeta>;
  putMeta(meta: SyncMeta): Promise<void>;
  archive(entry: ArchiveEntry): Promise<void>;
  /** Há um editor aberto neste documento, em qualquer janela deste perfil. */
  isHeld(key: string): Promise<boolean>;
  clearStaging(): Promise<void>;
  putStaged(documents: readonly StagedDocument[]): Promise<void>;
  listStaged(): Promise<StagedDocument[]>;
}

export interface SyncStorage {
  /** Tudo ou nada: se `work` falhar, nenhuma escrita permanece. */
  transaction<T>(work: (tx: SyncTx) => Promise<T>): Promise<T>;
}

export type AssetDoc = Extract<SyncDoc, { sha256: string }>;

/** Bytes locais de mídia, fora do banco de documentos. */
export interface AssetBytes {
  read(asset: AssetDoc): Promise<Blob | null>;
  has(asset: AssetDoc): Promise<boolean>;
  /** Confere tamanho e hash do que ficou gravado antes de publicar como disponível. */
  write(asset: AssetDoc, blob: Blob): Promise<'stored' | 'mismatch'>;
}

export type AssetRegistration = { id: string; state: 'pending' | 'ready' | 'failed'; uploadId: string };

/**
 * Falha de transporte. `network` não equivale a rejeição: a operação pode ter
 * sido aceita, e por isso a tentativa é repetida com o mesmo `opId`.
 */
export class TransportError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'contract',
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: { retryAfterMs?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export type IdentityCheck = 'ok' | 'unauthenticated' | 'mismatch' | 'unreachable';

export interface SyncTransport {
  /** A sessão online pertence ao usuário deste perfil? Pendências nunca saem com outra identidade. */
  checkIdentity(): Promise<IdentityCheck>;
  /** Renova a sessão uma vez; `false` se for preciso entrar de novo. */
  refreshSession(): Promise<boolean>;
  push(deviceId: string, operations: readonly SyncOperation[]): Promise<SyncResult[]>;
  pull(cursor: string, limit: number): Promise<SyncPullResponse>;
  bootstrapStart(limit: number): Promise<SyncBootstrapResponse>;
  bootstrapPage(token: string, cursor: string, limit: number): Promise<SyncBootstrapResponse>;
  registerAsset(asset: AssetDoc): Promise<AssetRegistration>;
  uploadAsset(asset: AssetDoc, uploadId: string, bytes: Blob): Promise<AssetRegistration>;
  downloadAsset(asset: AssetDoc): Promise<Blob>;
}

export type ConnectionState =
  /** Perfil pessoal: nada é enviado. */
  | 'local-only'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'auth-required'
  | 'identity-mismatch'
  | 'revoked'
  | 'read-only'
  | 'error';

export type PendingPhase = 'conflict' | 'blocked' | 'sending' | 'queued' | 'waiting-dependency' | 'waiting-upload' | 'expired' | 'suspended';

export type PendingItem = {
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  title: string;
  phase: PendingPhase;
  localGeneration: number;
  serverRevision: string | null;
  action: SyncAction | null;
  opId: string | null;
  attempts: number;
  code: string | null;
  deleted: boolean;
};

export type SyncSummary = {
  pending: number;
  conflicts: number;
  inTransit: number;
  blocked: number;
  cursor: string | null;
  lastSyncAt: string | null;
  suspended: SyncMeta['suspended'];
};
