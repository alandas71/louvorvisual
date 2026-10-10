import {
  CHANGE_DEBOUNCE_MS,
  SyncCoordinator,
  summarize,
  SyncScheduler,
  type ConnectionState,
  type CycleOutcome,
  type SyncProgress,
  type SyncSummary,
} from '@louvorvisual/sync';
import type { LocalSession } from '@/local/session';
import { SESSION_LOCK } from '@/pwa/serviceWorker';
import { HttpSyncTransport } from './api';
import { LocalAssetBytes } from './assetBytes';
import { DexieSyncStorage } from './dexieStorage';
import { updateTeamProfile } from './profiles';

export type SyncStatus = {
  connection: ConnectionState;
  /** Esta janela executa a sincronização do perfil; as outras só acompanham. */
  leader: boolean;
  summary: SyncSummary | null;
  lastOutcome: CycleOutcome | null;
  /** Ciclos concluídos desde que esta janela abriu (com ou sem sucesso). */
  cycles: number;
  /** Instante previsto da próxima tentativa automática depois de uma falha passageira. */
  nextRetryAt: number | null;
  /** Transferência em curso (arquivos ou alterações); `null` quando não há nada indo ou vindo. */
  progress: SyncProgress | null;
  /** Resultado da última transferência mostrada; some sozinho depois de alguns segundos. */
  transferResult: 'done' | 'failed' | 'offline' | null;
};

/** Envio de poucas alterações termina antes de dar para ler: só o envio em vários lotes é mostrado. */
const MIN_DOCUMENTS_SHOWN = 20;
const RESULT_VISIBLE_MS = { done: 2_500, failed: 6_000, offline: 6_000 } as const;

/** Transferência que vale mostrar a quem usa: bytes de áudio ou muitas alterações de uma vez. */
export function visibleProgress(progress: SyncProgress | null): SyncProgress | null {
  return progress && (progress.phase !== 'documents' || progress.total >= MIN_DOCUMENTS_SHOWN) ? progress : null;
}

/** Avisado quando documentos locais mudaram por sincronização ou resolução; as listas recarregam. */
export const LIBRARY_CHANGED_EVENT = 'lv:library-changed';

type Message = { type: 'status'; status: SyncStatus } | { type: 'status?' } | { type: 'sync-now' } | { type: 'local-change' } | { type: 'library-changed' };

const EMPTY_SUMMARY: SyncSummary = { pending: 0, conflicts: 0, inTransit: 0, blocked: 0, cursor: null, lastSyncAt: null, suspended: null };

/** Há uma apresentação aberta nesta origem (janela de projeção ou área do operador). */
async function isPresenting(): Promise<boolean> {
  if (new URLSearchParams(window.location.search).get('view') === 'apresentar') return true;
  try {
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === SESSION_LOCK);
  } catch {
    return false;
  }
}

/**
 * Sincronização de um perfil no navegador. Uma única janela por perfil executa
 * os ciclos (Web Locks); as demais recebem o estado por BroadcastChannel e
 * pedem ciclos à líder. O perfil pessoal não tem servidor: fica `local-only`.
 */
export class SyncEngine {
  readonly storage: DexieSyncStorage;
  private status: SyncStatus;
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;
  private scheduler: SyncScheduler | null = null;
  private stopped = false;
  private releaseLeadership: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private transferShown = false;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly session: LocalSession) {
    const { db, profile, team } = session;
    this.storage = new DexieSyncStorage(db, { workspaceId: profile.workspaceId, deviceId: profile.deviceId });
    this.status = { connection: team ? 'syncing' : 'local-only', leader: false, summary: null, lastOutcome: null, cycles: 0, nextRetryAt: null, progress: null, transferResult: null };
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`lv-sync:${profile.profileId}`);
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setStatus(changes: Partial<SyncStatus>, broadcast = true): void {
    this.status = { ...this.status, ...changes };
    for (const listener of this.listeners) listener();
    if (broadcast && this.status.leader) this.post({ type: 'status', status: { ...this.status, leader: false } });
  }

  private post(message: Message): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Canal fechado durante a saída da página.
    }
  }

  start(): void {
    const { db } = this.session;
    // Toda gravação que deixa um documento pendente pede um ciclo, venha de onde vier.
    const onDirty = (state: { dirty?: number } | undefined) => {
      if (state?.dirty === 1) this.onLocalChange();
    };
    db.entityStates.hook('creating', (_key, state) => onDirty(state));
    db.entityStates.hook('updating', (changes, _key, state) => onDirty({ ...state, ...(changes as object) }));

    this.channel?.addEventListener('message', (event: MessageEvent<Message>) => this.onMessage(event.data));
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.refreshSummary();
    this.post({ type: 'status?' });
    if (this.session.team) void this.lead();
  }

  stop(): void {
    this.stopped = true;
    this.scheduler?.stop();
    this.releaseLeadership?.();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.channel?.close();
  }

  /** Espera a vez de ser a janela que sincroniza este perfil e então inicia os ciclos. */
  private async lead(): Promise<void> {
    const run = () =>
      new Promise<void>((release) => {
        if (this.stopped) return release();
        this.releaseLeadership = release;
        this.setStatus({ leader: true });
        this.startScheduler();
      });
    if (!navigator.locks) return void run();
    await navigator.locks.request(`lv-sync:${this.session.profile.profileId}`, run);
  }

  private startScheduler(): void {
    const { session } = this;
    const team = session.team!;
    const transport = new HttpSyncTransport({ workspaceId: team.workspaceId, userId: team.userId }, (me) => {
      // Papel conhecido para a interface; quem decide é sempre o servidor.
      const membership = me.workspaces.find((workspace) => workspace.id === team.workspaceId);
      if (membership && (membership.role !== team.role || membership.name !== team.workspaceName)) {
        team.role = membership.role;
        team.workspaceName = membership.name;
        void updateTeamProfile(team.profileId, { role: membership.role, workspaceName: membership.name });
      }
    });
    const coordinator = new SyncCoordinator({
      storage: this.storage,
      transport,
      assets: new LocalAssetBytes(session.db, session.profile.profileId),
      workspaceId: team.workspaceId,
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
      isPresenting,
      onProgress: (progress) => {
        if (visibleProgress(progress)) {
          this.transferShown = true;
          if (this.resultTimer) clearTimeout(this.resultTimer);
          this.setStatus({ progress, transferResult: null });
        } else if (progress !== this.status.progress) this.setStatus({ progress });
      },
    });
    this.scheduler = new SyncScheduler({
      run: () => coordinator.syncOnce(),
      onStart: () => this.setStatus({ connection: 'syncing', nextRetryAt: null }),
      onOutcome: (outcome, nextRunInMs) => {
        this.setStatus({ connection: outcome.connection, lastOutcome: outcome, cycles: this.status.cycles + 1, nextRetryAt: outcome.retry && nextRunInMs !== null ? Date.now() + nextRunInMs : null, ...this.transferOutcome(outcome) }, false);
        void this.refreshSummary();
        if (outcome.adopted > 0 || outcome.conflictsOpened > 0 || outcome.downloaded > 0) this.announceLibraryChange();
      },
    });
    this.scheduler.start();
  }

  /** Fecha a transferência mostrada neste ciclo com o resultado dele. */
  private transferOutcome(outcome: CycleOutcome): Partial<SyncStatus> {
    if (!this.transferShown) return {};
    this.transferShown = false;
    const transferResult = outcome.connection === 'offline' ? 'offline' : outcome.retry || outcome.error ? 'failed' : 'done';
    this.resultTimer = setTimeout(() => {
      if (!this.stopped) this.setStatus({ transferResult: null });
    }, RESULT_VISIBLE_MS[transferResult]);
    return { transferResult };
  }

  private onOnline = () => this.scheduler?.request(0);
  private onOffline = () => {
    // `navigator.onLine` é só um sinal; o próximo ciclo confirma a conectividade real.
    if (this.status.leader && this.status.connection !== 'local-only') this.setStatus({ connection: 'offline' });
  };
  private onVisible = () => {
    if (document.visibilityState === 'visible') this.scheduler?.request(0);
  };

  private onMessage(message: Message): void {
    if (message.type === 'status' && !this.status.leader) this.setStatus({ ...message.status, leader: false }, false);
    if (message.type === 'status?' && this.status.leader) this.post({ type: 'status', status: { ...this.status, leader: false } });
    if (message.type === 'sync-now') this.scheduler?.request(0);
    if (message.type === 'local-change') {
      this.scheduler?.request(CHANGE_DEBOUNCE_MS);
      this.scheduleSummary();
    }
    if (message.type === 'library-changed') window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
  }

  private onLocalChange(): void {
    this.scheduler?.request(CHANGE_DEBOUNCE_MS);
    this.post({ type: 'local-change' });
    this.scheduleSummary();
  }

  private scheduleSummary(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSummary();
    }, 150);
  }

  async refreshSummary(): Promise<void> {
    const summary = await summarize(this.storage).catch(() => EMPTY_SUMMARY);
    if (!this.stopped) this.setStatus({ summary });
  }

  /** Download manual disponível também nas janelas que não são líderes. */
  async downloadAssets(assetIds: readonly string[]): Promise<void> {
    const { db, profile, team } = this.session;
    if (!team) throw new Error('Este perfil não está conectado a uma equipe.');
    const coordinator = new SyncCoordinator({
      storage: this.storage,
      transport: new HttpSyncTransport({ workspaceId: team.workspaceId, userId: team.userId }),
      assets: new LocalAssetBytes(db, profile.profileId),
      workspaceId: team.workspaceId,
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
      isPresenting,
    });
    const report = await coordinator.requestDownloads(assetIds);
    if (report.downloaded > 0) this.announceLibraryChange();
    if (report.downloadsDeferred > 0) throw new Error('Encerre a apresentação e clique em baixar novamente.');
  }

  /** Ação manual "Sincronizar agora". */
  syncNow(): void {
    if (this.scheduler) this.scheduler.request(0);
    else this.post({ type: 'sync-now' });
  }

  /** Documentos mudaram fora do editor (sync ou resolução de conflito): as vistas recarregam. */
  announceLibraryChange(): void {
    window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
    this.post({ type: 'library-changed' });
    void this.refreshSummary();
  }
}

const engines = new WeakMap<LocalSession, SyncEngine>();

/** Um motor por sessão local aberta nesta janela. */
export function syncEngine(session: LocalSession): SyncEngine {
  let engine = engines.get(session);
  if (!engine) {
    engine = new SyncEngine(session);
    engines.set(session, engine);
    engine.start();
  }
  return engine;
}
