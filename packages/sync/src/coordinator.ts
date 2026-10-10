import type { SyncOperation, SyncResult } from '@louvorvisual/contracts';
import { SCHEMA_VERSION } from '@louvorvisual/domain';
import { dependenciesOf, isNewerRevision, revisionNumber, sameContent } from './compare';
import {
  ENTITY_ORDER,
  entityKey,
  TransportError,
  type AssetBytes,
  type AssetDoc,
  type ConflictKind,
  type ConflictRecord,
  type ConnectionState,
  type EntityState,
  type QueuedOperation,
  type RemoteVersion,
  type SyncAction,
  type SyncDoc,
  type SyncEntityType,
  type SuspensionCode,
  type SyncStorage,
  type SyncTransport,
  type SyncTx,
} from './types';

/** Limites do contrato (planejamento/12): 20 operações e 2 MiB por requisição, com folga para o envelope. */
export const MAX_BATCH_OPERATIONS = 20;
export const MAX_BATCH_BYTES = 1_800_000;
const PAGE_SIZE = 100;
/** Espera antes de recapturar um agregado recusado por dependência ainda não pronta no servidor. */
const DEPENDENCY_RETRY_MS = 30_000;

export type CycleReport = {
  pushed: number;
  pulled: number;
  adopted: number;
  conflictsOpened: number;
  uploaded: number;
  downloaded: number;
  downloadsDeferred: number;
  bootstrapped: boolean;
};

export type CycleOutcome = CycleReport & {
  connection: ConnectionState;
  /** Falha passageira: tentar de novo com backoff. */
  retry: boolean;
  retryAfterMs: number | null;
  error: { code: string; message: string } | null;
};

export type CoordinatorDeps = {
  storage: SyncStorage;
  transport: SyncTransport;
  assets: AssetBytes;
  workspaceId: string;
  now: () => string;
  newId: () => string;
  /** Durante uma apresentação, downloads de mídia ficam suspensos (planejamento/09). */
  isPresenting?: () => boolean | Promise<boolean>;
};

class NeedBootstrap extends Error {}
class PushForbidden extends Error {}

const emptyReport = (): CycleReport => ({ pushed: 0, pulled: 0, adopted: 0, conflictsOpened: 0, uploaded: 0, downloaded: 0, downloadsDeferred: 0, bootstrapped: false });

function conflictKind(local: SyncDoc, remote: SyncDoc): ConflictKind {
  if (remote.deletedAt !== null) return 'remote-deleted';
  if (local.deletedAt !== null) return 'local-deleted';
  return 'both-edited';
}

function newerOf(a: RemoteVersion | null | undefined, b: RemoteVersion): RemoteVersion {
  return a && !isNewerRevision(b.revision, a.revision) ? a : b;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function toWire(operation: QueuedOperation): SyncOperation {
  return {
    opId: operation.opId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    action: operation.action,
    baseRevision: operation.baseRevision,
    schemaVersion: SCHEMA_VERSION,
    payload: operation.payload,
  };
}

/** Lotes formados pela quantidade e pelo tamanho serializado; um agregado nunca é dividido. */
export function formBatches(operations: readonly QueuedOperation[]): QueuedOperation[][] {
  const batches: QueuedOperation[][] = [];
  let current: QueuedOperation[] = [];
  let bytes = 0;
  for (const operation of operations) {
    const size = serializedBytes(toWire(operation)) + 1;
    if (current.length > 0 && (current.length >= MAX_BATCH_OPERATIONS || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(operation);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Coordenador de sincronização de um perfil/espaço. Não conhece Dexie, Room
 * nem fetch: recebe armazenamento, transporte e bytes por contrato, de modo
 * que as regras de geração, captura, revisão e conflito sejam as mesmas no web
 * e no Android.
 */
export class SyncCoordinator {
  private running: Promise<CycleOutcome> | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Um ciclo completo. Chamadas simultâneas compartilham o mesmo ciclo. */
  syncOnce(): Promise<CycleOutcome> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Baixa somente as faixas escolhidas explicitamente pelo usuário. */
  async requestDownloads(assetIds: readonly string[]): Promise<CycleReport> {
    const report = emptyReport();
    let identity = await this.deps.transport.checkIdentity();
    if (identity === 'unauthenticated' && await this.deps.transport.refreshSession()) identity = await this.deps.transport.checkIdentity();
    if (identity !== 'ok') throw new Error(identity === 'unreachable' ? 'Sem conexão para baixar. Tente de novo quando estiver online.' : 'Entre na conta desta equipe para baixar.');
    await this.downloadAssets(report, new Set(assetIds));
    return report;
  }

  private async run(): Promise<CycleOutcome> {
    const report = emptyReport();
    const done = (connection: ConnectionState, extra: Partial<CycleOutcome> = {}): CycleOutcome => ({ ...report, connection, retry: false, retryAfterMs: null, error: null, ...extra });
    try {
      let identity = await this.deps.transport.checkIdentity();
      if (identity === 'unauthenticated' && (await this.deps.transport.refreshSession().catch(() => false))) identity = await this.deps.transport.checkIdentity();
      if (identity === 'unreachable') return done('offline', { retry: true });
      if (identity === 'unauthenticated') return done('auth-required');
      // Pendências deste perfil nunca saem com a autenticação de outra conta.
      if (identity === 'mismatch') return done('identity-mismatch');

      let readOnly = false;
      for (let round = 0; ; round += 1) {
        try {
          const meta = await this.deps.storage.transaction((tx) => tx.getMeta());
          if (meta.needsBootstrap || meta.cursor === null) await this.bootstrap(report);
          await this.pullAll(report);
          await this.clearSuspension('revoked');
          readOnly = await this.pushPhase(report);
          await this.pullAll(report);
          break;
        } catch (error) {
          if (!(error instanceof NeedBootstrap) || round >= 2) throw error;
        }
      }
      await this.deps.storage.transaction(async (tx) => {
        const meta = await tx.getMeta();
        await tx.putMeta({ ...meta, lastSyncAt: this.deps.now() });
      });
      return done(readOnly ? 'read-only' : 'idle');
    } catch (error) {
      return done(...(await this.classify(error)));
    }
  }

  private async classify(error: unknown): Promise<[ConnectionState, Partial<CycleOutcome>]> {
    if (!(error instanceof TransportError)) {
      return ['error', { retry: true, error: { code: 'LOCAL_ERROR', message: error instanceof Error ? error.message : String(error) } }];
    }
    const detail = { code: error.code, message: error.message };
    if (error.kind === 'network') return ['offline', { retry: true }];
    if (error.kind === 'contract') return ['error', { error: detail }];
    if (error.status === 401) return ['auth-required', {}];
    if (error.status === 403 && error.code === 'WORKSPACE_ACCESS_REVOKED') {
      await this.suspend('revoked', error.message);
      return ['revoked', { error: detail }];
    }
    if (error.status === 404) {
      await this.suspend('workspace-missing', error.message);
      return ['error', { error: detail }];
    }
    if (error.status === 429 || error.status >= 500) return ['error', { retry: true, retryAfterMs: error.options.retryAfterMs ?? null, error: detail }];
    return ['error', { error: detail }];
  }

  private suspend(code: SuspensionCode, message: string): Promise<void> {
    return this.deps.storage.transaction(async (tx) => {
      const meta = await tx.getMeta();
      await tx.putMeta({ ...meta, suspended: { code, message, at: this.deps.now() } });
    });
  }

  private clearSuspension(code: string): Promise<void> {
    return this.deps.storage.transaction(async (tx) => {
      const meta = await tx.getMeta();
      if (meta.suspended?.code === code || meta.suspended?.code === 'workspace-missing') await tx.putMeta({ ...meta, suspended: null });
    });
  }

  /** Em 401, renova a sessão uma vez e repete a mesma chamada. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof TransportError && error.status === 401 && (await this.deps.transport.refreshSession().catch(() => false))) return request();
      throw error;
    }
  }

  // ---------------------------------------------------------------- recebimento

  /**
   * Integra uma versão remota ao estado local. Nunca substitui conteúdo local
   * mais novo: documento sujo vira conflito, tentativa em trânsito e editor
   * aberto adiam a decisão.
   */
  private async integrate(tx: SyncTx, entityType: SyncEntityType, remote: RemoteVersion, report: CycleReport): Promise<void> {
    const { document, revision } = remote;
    const key = entityKey(entityType, document.id);
    const state = await tx.getState(key);
    const adopt = async (previous: EntityState | undefined, clean: boolean) => {
      await tx.putDocument(entityType, document);
      await tx.putState({
        key,
        entityType,
        entityId: document.id,
        workspaceId: document.workspaceId,
        localGeneration: previous?.localGeneration ?? 0,
        updatedAt: document.updatedAt,
        ...previous,
        serverRevision: revision,
        lastAckSnapshot: document,
        dirty: clean ? 0 : (previous?.dirty ?? 0),
        conflict: null,
        deferredRemote: null,
        blocked: null,
      });
      report.adopted += 1;
    };

    if (!state) return adopt(undefined, true);
    if (state.serverRevision !== null && !isNewerRevision(revision, state.serverRevision)) return;

    if (state.conflict) {
      const conflict = await tx.getConflict(state.conflict);
      if (conflict?.status === 'open') {
        // Outra edição chegou antes da resolução: a comparação passa a ser com a mais nova.
        if (isNewerRevision(revision, conflict.remoteRevision)) {
          const local = (await tx.getDocument(entityType, document.id)) ?? conflict.local;
          await tx.putConflict({ ...conflict, remote: document, remoteRevision: revision, kind: conflictKind(local, document) });
        }
        return;
      }
    }

    const operation = await tx.getOperationByKey(key);
    if (operation && operation.firstSentAt !== null) {
      // Tentativa em trânsito: o resultado idempotente dela decide; guardar o remoto para depois.
      await tx.putState({ ...state, deferredRemote: newerOf(state.deferredRemote, remote) });
      return;
    }
    if (operation) await tx.deleteOperation(operation.opId);

    if (state.dirty === 0) {
      if (await tx.isHeld(key)) {
        await tx.putState({ ...state, deferredRemote: newerOf(state.deferredRemote, remote) });
        return;
      }
      return adopt(state, true);
    }

    const local = await tx.getDocument(entityType, document.id);
    if (!local || sameContent(local, document) || (local.deletedAt !== null && document.deletedAt !== null)) return adopt(state, true);
    await this.openConflict(tx, state, local, remote, report);
  }

  private async openConflict(tx: SyncTx, state: EntityState, local: SyncDoc, remote: RemoteVersion, report: CycleReport): Promise<void> {
    const conflict: ConflictRecord = {
      id: this.deps.newId(),
      key: state.key,
      entityType: state.entityType,
      entityId: state.entityId,
      workspaceId: state.workspaceId,
      kind: conflictKind(local, remote.document),
      base: state.lastAckSnapshot,
      baseRevision: state.serverRevision,
      local,
      localGeneration: state.localGeneration,
      remote: remote.document,
      remoteRevision: remote.revision,
      detectedAt: this.deps.now(),
      status: 'open',
      resolution: null,
      resolvedAt: null,
    };
    await tx.putConflict(conflict);
    await tx.putState({ ...state, conflict: conflict.id, deferredRemote: null, blocked: null });
    report.conflictsOpened += 1;
  }

  /** Versões adiadas cuja tentativa já terminou ou cujo editor já fechou. */
  private async settleDeferred(tx: SyncTx, report: CycleReport): Promise<void> {
    for (const state of await tx.listStates()) {
      if (!state.deferredRemote) continue;
      const operation = await tx.getOperationByKey(state.key);
      if (operation && operation.firstSentAt !== null) continue;
      const remote = state.deferredRemote;
      await tx.putState({ ...state, deferredRemote: null });
      await this.integrate(tx, state.entityType, remote, report);
    }
  }

  private async pullAll(report: CycleReport): Promise<void> {
    for (;;) {
      const cursor = (await this.deps.storage.transaction((tx) => tx.getMeta())).cursor ?? '0';
      let page;
      try {
        page = await this.call(() => this.deps.transport.pull(cursor, PAGE_SIZE));
      } catch (error) {
        if (error instanceof TransportError && error.status === 410) {
          await this.requireBootstrap();
          throw new NeedBootstrap();
        }
        throw error;
      }
      // A página e o cursor confirmam juntos: uma interrupção repete a página inteira.
      await this.deps.storage.transaction(async (tx) => {
        for (const change of page.changes) {
          if (change.document.workspaceId !== this.deps.workspaceId) continue;
          await this.integrate(tx, change.entityType, { revision: change.revision, document: change.document }, report);
        }
        const meta = await tx.getMeta();
        if (revisionNumber(page.nextCursor) > revisionNumber(meta.cursor)) await tx.putMeta({ ...meta, cursor: page.nextCursor });
      });
      report.pulled += page.changes.length;
      if (!page.hasMore) return;
    }
  }

  private requireBootstrap(): Promise<void> {
    return this.deps.storage.transaction(async (tx) => {
      const meta = await tx.getMeta();
      await tx.putMeta({ ...meta, needsBootstrap: true });
    });
  }

  /**
   * Bootstrap em área separada: só depois de todas as páginas a base limpa é
   * substituída e as pendências são reconciliadas. Documentos sujos e
   * tentativas sem confirmação nunca são descartados.
   */
  private async bootstrap(report: CycleReport): Promise<void> {
    let cutCursor = '0';
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.deps.storage.transaction((tx) => tx.clearStaging());
        let page = await this.call(() => this.deps.transport.bootstrapStart(PAGE_SIZE));
        cutCursor = page.cutCursor;
        for (;;) {
          const documents = page.documents;
          await this.deps.storage.transaction((tx) => tx.putStaged(documents));
          if (!page.hasMore) break;
          const { token, nextCursor } = page;
          page = await this.call(() => this.deps.transport.bootstrapPage(token, nextCursor, PAGE_SIZE));
        }
        break;
      } catch (error) {
        // Fotografia vencida: recomeça a leitura; nada local foi tocado.
        if (!(error instanceof TransportError && error.status === 410 && error.code === 'BOOTSTRAP_EXPIRED') || attempt >= 2) throw error;
      }
    }

    await this.deps.storage.transaction(async (tx) => {
      // Tentativas vencidas não são reenviadas: a comparação com a nova base decide o destino de cada uma.
      for (const operation of await tx.listOperations()) if (operation.status === 'expired') await tx.deleteOperation(operation.opId);
      const staged = await tx.listStaged();
      const seen = new Set<string>();
      for (const item of staged) {
        if (item.document.workspaceId !== this.deps.workspaceId) continue;
        seen.add(entityKey(item.entityType, item.entityId));
        await this.integrate(tx, item.entityType, { revision: item.revision, document: item.document }, report);
      }
      // Registro confirmado que a nova base não traz mais: sai da biblioteca, com cópia recuperável.
      for (const state of await tx.listStates()) {
        if (seen.has(state.key) || state.serverRevision === null || state.dirty === 1 || state.workspaceId !== this.deps.workspaceId) continue;
        const document = await tx.getDocument(state.entityType, state.entityId);
        if (!document || document.deletedAt !== null) continue;
        const now = this.deps.now();
        await tx.archive({ entityType: state.entityType, entityId: state.entityId, workspaceId: state.workspaceId, reason: 'bootstrap-missing', document, createdAt: now });
        await tx.putDocument(state.entityType, { ...document, deletedAt: now } as SyncDoc);
      }
      const meta = await tx.getMeta();
      await tx.putMeta({ ...meta, cursor: cutCursor, needsBootstrap: false });
      await tx.clearStaging();
    });
    report.bootstrapped = true;
  }

  // ---------------------------------------------------------------------- envio

  /** Devolve `true` quando o papel atual não permite publicar (somente leitura). */
  private async pushPhase(report: CycleReport): Promise<boolean> {
    try {
      await this.uploadAssets(report);
      const attempted = new Set<string>();
      for (let round = 0; round < 50; round += 1) {
        const queued = await this.deps.storage.transaction(async (tx) => {
          await this.settleDeferred(tx, report);
          await this.capture(tx);
          return (await tx.listOperations()).filter((operation) => operation.status === 'queued' && !attempted.has(operation.opId));
        });
        if (queued.length === 0) break;
        queued.sort((a, b) => ENTITY_ORDER.indexOf(a.entityType) - ENTITY_ORDER.indexOf(b.entityType) || a.createdAt.localeCompare(b.createdAt));
        for (const operation of queued) attempted.add(operation.opId);
        for (const batch of formBatches(queued)) await this.sendBatch(batch, report);
      }
      await this.clearSuspension('read-only');
      return false;
    } catch (error) {
      if (!(error instanceof PushForbidden)) throw error;
      await this.suspend('read-only', 'Seu papel nesta equipe não permite publicar alterações.');
      return true;
    }
  }

  /**
   * Captura uma tentativa imutável para cada documento sujo que pode ser
   * enviado agora. Um documento tem no máximo uma tentativa; a que nunca saiu
   * do dispositivo é trocada pela captura mais nova (condensa edições).
   */
  private async capture(tx: SyncTx): Promise<void> {
    const now = this.deps.now();
    const dirty = (await tx.listDirtyStates()).filter((state) => state.workspaceId === this.deps.workspaceId);
    dirty.sort((a, b) => ENTITY_ORDER.indexOf(a.entityType) - ENTITY_ORDER.indexOf(b.entityType));
    for (const state of dirty) {
      if (state.conflict || state.deferredRemote) continue;
      if (state.blocked && state.blocked.generation === state.localGeneration && (state.blocked.retryAt === null || state.blocked.retryAt > now)) continue;
      const existing = await tx.getOperationByKey(state.key);
      if (existing) {
        if (existing.firstSentAt !== null || existing.status !== 'queued' || existing.capturedGeneration >= state.localGeneration) continue;
        await tx.deleteOperation(existing.opId);
      }
      const document = await tx.getDocument(state.entityType, state.entityId);
      if (!document) continue;

      const ackDeleted = state.lastAckSnapshot ? state.lastAckSnapshot.deletedAt !== null : false;
      let action: SyncAction;
      if (state.serverRevision === null) {
        // Criado e excluído sem nunca ter sido enviado: não há nada a publicar.
        if (document.deletedAt !== null) {
          await tx.putState({ ...state, dirty: 0, blocked: null });
          continue;
        }
        action = 'create';
      } else if (document.deletedAt !== null) {
        if (ackDeleted) {
          await tx.putState({ ...state, dirty: 0, blocked: null });
          continue;
        }
        action = 'delete';
      } else {
        action = ackDeleted ? 'restore' : 'update';
      }

      if (state.entityType === 'asset' && (document as AssetDoc).remoteState !== 'ready') continue;
      let payload: SyncDoc = 'serverRevision' in document ? ({ ...document, serverRevision: state.serverRevision } as SyncDoc) : document;
      if (action !== 'delete') {
        let ready = true;
        for (const dependency of dependenciesOf(state.entityType, document)) {
          const dependencyState = await tx.getState(dependency);
          if (!dependencyState || dependencyState.serverRevision === null) ready = false;
          // A referência à letra passa a apontar para a revisão aceita do louvor.
          else if (dependencyState.entityType === 'song' && 'basedOnSongRevision' in payload && payload.basedOnSongRevision === null) {
            payload = { ...payload, basedOnSongRevision: dependencyState.serverRevision };
          }
        }
        if (!ready) continue;
      }

      await tx.putOperation({
        opId: this.deps.newId(),
        key: state.key,
        entityType: state.entityType,
        entityId: state.entityId,
        action,
        baseRevision: state.serverRevision ?? '0',
        capturedGeneration: state.localGeneration,
        payload: structuredClone(payload),
        createdAt: now,
        attempts: 0,
        firstSentAt: null,
        lastAttemptAt: null,
        lastError: null,
        status: 'queued',
      });
    }
  }

  private async sendBatch(batch: readonly QueuedOperation[], report: CycleReport): Promise<void> {
    const now = this.deps.now();
    // O registro da tentativa é gravado antes de a requisição começar.
    await this.deps.storage.transaction(async (tx) => {
      for (const operation of batch) await tx.putOperation({ ...operation, attempts: operation.attempts + 1, firstSentAt: operation.firstSentAt ?? now, lastAttemptAt: now });
    });
    const deviceId = (await this.deps.storage.transaction((tx) => tx.getMeta())).deviceId;

    let results: SyncResult[];
    try {
      results = await this.call(() => this.deps.transport.push(deviceId, batch.map(toWire)));
    } catch (error) {
      if (!(error instanceof TransportError) || error.kind !== 'http') {
        await this.noteError(batch, error instanceof TransportError ? error.code : 'LOCAL_ERROR');
        throw error;
      }
      if (error.status === 403 && error.code === 'WORKSPACE_FORBIDDEN') {
        // Recusada pelo papel antes de qualquer aplicação: a tentativa volta a
        // contar como nunca enviada, para o recebimento poder comparar versões.
        await this.deps.storage.transaction(async (tx) => {
          for (const operation of batch) await tx.putOperation({ ...operation, attempts: operation.attempts + 1, lastAttemptAt: now, lastError: error.code });
        });
        throw new PushForbidden();
      }
      if (error.status === 410 && error.code === 'DEVICE_EXPIRED') {
        await this.expireDevice();
        throw new NeedBootstrap();
      }
      const isolating = error.status === 413 || error.status === 400 || (error.status === 409 && error.code === 'IDEMPOTENCY_KEY_REUSED');
      if (!isolating) {
        await this.noteError(batch, error.code);
        throw error;
      }
      // Falha global do lote: reenviar uma a uma para saber qual operação a causou.
      if (batch.length > 1) {
        for (const operation of batch) await this.sendBatch([{ ...operation, attempts: operation.attempts + 1, firstSentAt: operation.firstSentAt ?? now }], report);
        return;
      }
      const [operation] = batch as [QueuedOperation];
      await this.deps.storage.transaction(async (tx) => {
        if (error.status === 409) {
          // Erro de contrato: a tentativa fica suspensa e registrada, nunca regravada com outro payload.
          await tx.putOperation({ ...operation, attempts: operation.attempts + 1, firstSentAt: operation.firstSentAt ?? now, lastAttemptAt: now, status: 'suspended', lastError: error.code });
          return;
        }
        // Recusada antes de ser aplicada (validação ou tamanho): não repetir sem alteração.
        await tx.deleteOperation(operation.opId);
        const state = await tx.getState(operation.key);
        if (state) await tx.putState({ ...state, blocked: { code: error.code, generation: operation.capturedGeneration, retryAt: null, details: error.options.details } });
      });
      return;
    }

    const byId = new Map(batch.map((operation) => [operation.opId, operation]));
    await this.deps.storage.transaction(async (tx) => {
      for (const result of results) {
        const operation = byId.get(result.opId);
        if (operation) await this.applyResult(tx, operation, result, report);
      }
    });
  }

  private noteError(batch: readonly QueuedOperation[], code: string): Promise<void> {
    return this.deps.storage.transaction(async (tx) => {
      for (const operation of batch) {
        const current = await tx.getOperationByKey(operation.key);
        if (current?.opId === operation.opId) await tx.putOperation({ ...current, lastError: code });
      }
    });
  }

  /** A janela de idempotência deste dispositivo venceu: nada antigo é reenviado sem reconciliação. */
  private expireDevice(): Promise<void> {
    return this.deps.storage.transaction(async (tx) => {
      for (const operation of await tx.listOperations()) {
        if (operation.firstSentAt === null) await tx.deleteOperation(operation.opId);
        else await tx.putOperation({ ...operation, status: 'expired', lastError: 'DEVICE_EXPIRED' });
      }
      const meta = await tx.getMeta();
      await tx.putMeta({ ...meta, needsBootstrap: true, deviceId: this.deps.newId() });
    });
  }

  private async applyResult(tx: SyncTx, operation: QueuedOperation, result: SyncResult, report: CycleReport): Promise<void> {
    await tx.deleteOperation(operation.opId);
    const state = await tx.getState(operation.key);
    if (!state) return;

    if (result.status === 'accepted') {
      report.pushed += 1;
      const acknowledged = ('serverRevision' in operation.payload ? { ...operation.payload, serverRevision: result.revision } : operation.payload) as SyncDoc;
      const deferred = state.deferredRemote ?? null;
      // A confirmação atualiza a base. O conteúdo só é dado como enviado se a
      // geração ainda for a capturada: uma edição mais nova continua pendente
      // e o documento local não é tocado.
      await tx.putState({
        ...state,
        serverRevision: result.revision,
        lastAckSnapshot: acknowledged,
        dirty: state.localGeneration === operation.capturedGeneration ? 0 : 1,
        deferredRemote: null,
        blocked: null,
      });
      if (deferred && isNewerRevision(deferred.revision, result.revision)) await this.integrate(tx, operation.entityType, deferred, report);
      return;
    }

    if (result.status === 'conflict') {
      const remote = newerOf(state.deferredRemote, { revision: result.currentRevision, document: result.document });
      const cleared: EntityState = { ...state, deferredRemote: null };
      await tx.putState(cleared);
      const local = (await tx.getDocument(operation.entityType, operation.entityId)) ?? operation.payload;
      if (sameContent(local, remote.document) || (local.deletedAt !== null && remote.document.deletedAt !== null)) {
        // O servidor já tem este conteúdo (por exemplo, a tentativa anterior foi aplicada): não há o que decidir.
        await tx.putDocument(operation.entityType, remote.document);
        await tx.putState({ ...cleared, serverRevision: remote.revision, lastAckSnapshot: remote.document, dirty: 0, blocked: null });
        return;
      }
      await this.openConflict(tx, cleared, local, remote, report);
      return;
    }

    // Rejeitada: o servidor guardou esse resultado para o opId, então a mesma
    // tentativa nunca seria aceita. Uma nova só nasce de uma nova captura.
    const retryable = result.code === 'DEPENDENCY_NOT_READY';
    await tx.putState({
      ...state,
      blocked: {
        code: result.code,
        generation: operation.capturedGeneration,
        retryAt: retryable ? new Date(Date.parse(this.deps.now()) + DEPENDENCY_RETRY_MS).toISOString() : null,
        details: result.details,
      },
    });
  }

  // ---------------------------------------------------------------------- mídia

  /** Grava um documento alterado pela própria sincronização, como qualquer edição local. */
  private async writeLocal(tx: SyncTx, entityType: SyncEntityType, document: SyncDoc, blocked: EntityState['blocked'] = null): Promise<void> {
    const key = entityKey(entityType, document.id);
    const state = await tx.getState(key);
    if (!state) return;
    await tx.putDocument(entityType, document);
    await tx.putState({ ...state, localGeneration: state.localGeneration + 1, dirty: 1, blocked: blocked ? { ...blocked, generation: state.localGeneration + 1 } : null });
  }

  /** Arquivos primeiro: registra, envia os bytes e só então o documento do arquivo pode ser publicado. */
  private async uploadAssets(report: CycleReport): Promise<void> {
    const waiting = await this.deps.storage.transaction(async (tx) => {
      const assets: AssetDoc[] = [];
      for (const state of await tx.listDirtyStates()) {
        if (state.entityType !== 'asset' || state.workspaceId !== this.deps.workspaceId || state.conflict) continue;
        if (state.blocked && state.blocked.generation === state.localGeneration && state.blocked.retryAt === null) continue;
        const document = (await tx.getDocument('asset', state.entityId)) as AssetDoc | undefined;
        if (document && document.deletedAt === null && document.remoteState !== 'ready') assets.push(document);
      }
      return assets;
    });

    for (const asset of waiting) {
      const update = (changes: Partial<AssetDoc>, blocked: EntityState['blocked'] = null) =>
        this.deps.storage.transaction((tx) => this.writeLocal(tx, 'asset', { ...asset, ...changes, updatedAt: this.deps.now() }, blocked));
      const bytes = await this.deps.assets.read(asset);
      if (!bytes) {
        await update({ remoteState: 'failed' }, { code: 'LOCAL_BYTES_MISSING', generation: 0, retryAt: null });
        continue;
      }
      try {
        let registration = await this.call(() => this.deps.transport.registerAsset(asset));
        if (registration.id !== asset.id) throw new TransportError('contract', 200, 'ASSET_ID_MISMATCH', 'O servidor registrou o arquivo com outro ID.');
        if (registration.state !== 'ready') {
          const { uploadId } = registration;
          registration = await this.call(() => this.deps.transport.uploadAsset(asset, uploadId, bytes));
        }
        if (registration.state !== 'ready') throw new TransportError('contract', 200, 'ASSET_NOT_READY', 'O servidor não confirmou o arquivo.');
        await update({ remoteState: 'ready' });
        report.uploaded += 1;
      } catch (error) {
        if (!(error instanceof TransportError) || error.kind === 'network') throw error;
        if (error.status === 403 && error.code === 'WORKSPACE_FORBIDDEN') throw new PushForbidden();
        if (error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500) throw error;
        // Tentativa de upload trocada por outra janela/ciclo: registrar de novo no próximo ciclo.
        if (error.code === 'UPLOAD_ATTEMPT_INVALID') continue;
        await update({ remoteState: 'failed' }, { code: error.code, generation: 0, retryAt: null });
      }
    }
  }

  /** Baixa os bytes das faixas usadas por arranjos e ainda ausentes neste dispositivo. */
  private async downloadAssets(report: CycleReport, requested: ReadonlySet<string>): Promise<void> {
    const missing = await this.deps.storage.transaction(async (tx) => {
      const used = new Set<string>();
      for (const arrangement of await tx.listDocuments('arrangement')) {
        if (arrangement.deletedAt !== null) continue;
        for (const binding of ((arrangement as Record<string, unknown>).audioBindings as { assetId: string }[] | undefined) ?? []) used.add(binding.assetId);
      }
      return ((await tx.listDocuments('asset')) as AssetDoc[]).filter((asset) => requested.has(asset.id) && used.has(asset.id) && asset.deletedAt === null && asset.remoteState === 'ready' && asset.workspaceId === this.deps.workspaceId);
    });
    for (const asset of missing) {
      if (await this.deps.assets.has(asset)) continue;
      if (await this.deps.isPresenting?.()) {
        report.downloadsDeferred += 1;
        continue;
      }
      const bytes = await this.call(() => this.deps.transport.downloadAsset(asset));
      // Bytes incompletos ou diferentes do hash nunca ficam referenciados como disponíveis.
      if ((await this.deps.assets.write(asset, bytes)) !== 'stored') throw new Error('O arquivo baixado não confere com o original. Tente baixar de novo.');
      report.downloaded += 1;
    }
  }
}
