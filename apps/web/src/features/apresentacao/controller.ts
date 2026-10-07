import type { Uuid } from '@louvorvisual/domain';
import {
  ControllerLink,
  HEARTBEAT_INTERVAL_MS,
  PresentationEngine,
  SUSPENSION_THRESHOLD_MS,
  type CommandResult,
  type EngineClock,
  type EngineView,
  type LinkStatus,
  type OperatorCommand,
  type Rotation,
  type SessionCheckpoint,
  type SessionSnapshot,
  type VisualState,
} from '@louvorvisual/presentation';
import type { HtmlAudioTransport } from '../audio/htmlTransport';
import { openLocalChannel, type LocalChannel } from './channel';

/** Relógio real do navegador: `performance.now()` é monotônico neste processo. */
export const browserClock: EngineClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** "Guardado nesta sessão" só depois da confirmação do banco; falha deixa o ajuste só em memória. */
export type CheckpointState = 'saved' | 'saving' | 'memory-only';

/** Bloqueio de tela: ajuda a manter o dispositivo acordado, sem garantir execução em segundo plano. */
export type WakeLockState = 'unsupported' | 'active' | 'released';

export type ControllerSnapshot = {
  view: EngineView;
  link: LinkStatus;
  checkpoint: CheckpointState;
  wakeLock: WakeLockState;
  /** Tempo entre publicar a última troca e a janela pública confirmá-la. */
  lastConfirmMs: number | null;
};

export type ControllerStorage = {
  saveCheckpoint(checkpoint: SessionCheckpoint): Promise<void>;
  saveRotation(rotation: Rotation): Promise<void>;
};

export type ControllerOptions = {
  snapshot: SessionSnapshot;
  sessionId: Uuid;
  checkpoint: SessionCheckpoint | null;
  rotation: Rotation;
  storage: ControllerStorage;
  /** Cresce a cada controlador criado; a janela pública ignora gerações antigas. */
  generation: number;
  /** Player único da faixa da sessão; pertence a este controlador, que o descarta ao sair. */
  transport: HtmlAudioTransport | null;
};

/**
 * Detecta que o dispositivo ou a aba ficou sem executar: o batimento de 1 s
 * chegou com atraso maior que o limite de suspensão. Usa o relógio de parede,
 * que continua andando enquanto o computador dorme.
 */
export class SuspensionDetector {
  private last: number;

  constructor(now: number, private readonly thresholdMs = SUSPENSION_THRESHOLD_MS) {
    this.last = now;
  }

  /** Registra um batimento; `true` se o intervalo desde o anterior indica suspensão. */
  beat(now: number): boolean {
    const gap = now - this.last;
    this.last = now;
    return gap > this.thresholdMs;
  }
}

const CHECKPOINT_DEBOUNCE_MS = 150;
const PROGRESS_CHECKPOINT_MS = 5000;

/**
 * Controlador único da sessão nesta janela: liga o motor ao canal da projeção e
 * ao checkpoint. A janela pública nunca roda outro motor; ela só recebe estado.
 */
export class SessionController {
  readonly engine: PresentationEngine;
  readonly sessionId: Uuid;
  private readonly link: ControllerLink;
  private readonly storage: ControllerStorage;
  private readonly listeners = new Set<() => void>();
  private channel: LocalChannel | null = null;
  private snapshot: ControllerSnapshot;
  private checkpointState: CheckpointState = 'saved';
  private checkpointTimer: number | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeVersion = 0;
  private heartbeat: number | null = null;
  private lastProgressAt = 0;
  private lastRotation: Rotation;
  private lastConfirmMs: number | null = null;
  private readonly publishedAt = new Map<number, number>();
  private confirmed = -1;
  private unsubscribe: (() => void) | null = null;
  private readonly transport: HtmlAudioTransport | null;
  private readonly suspension = new SuspensionDetector(Date.now());
  private wakeLock: WakeLockState = 'unsupported';
  private wakeSentinel: WakeLockSentinel | null = null;
  private disposed = false;

  constructor(options: ControllerOptions) {
    this.sessionId = options.sessionId;
    this.storage = options.storage;
    this.transport = options.transport;
    this.engine = new PresentationEngine({
      snapshot: options.snapshot,
      clock: browserClock,
      sessionId: options.sessionId,
      rotation: options.rotation,
      checkpoint: options.checkpoint ?? undefined,
      transport: options.transport,
    });
    this.lastRotation = this.engine.getView().rotation;
    this.link = new ControllerLink(options.sessionId, options.generation, { title: options.snapshot.song.title, artist: options.snapshot.song.artist });
    this.snapshot = this.read();
  }

  private visualState(): VisualState {
    const view = this.engine.getView();
    return { sequenceNumber: view.state.sequenceNumber, frame: view.output, rotation: view.rotation, controls: view.controls };
  }

  private read(): ControllerSnapshot {
    return { view: this.engine.getView(), link: this.link.status(performance.now()), checkpoint: this.checkpointState, wakeLock: this.wakeLock, lastConfirmMs: this.lastConfirmMs };
  }

  private notify(): void {
    this.snapshot = this.read();
    for (const listener of [...this.listeners]) listener();
  }

  /** Abre o canal, passa a publicar o estado e a verificar a conexão. */
  start(): void {
    this.channel = openLocalChannel((message) => this.onMessage(message));
    this.unsubscribe = this.engine.subscribe(() => this.onEngineChange());
    this.channel?.post(this.link.snapshotMessage(this.visualState()));
    this.heartbeat = window.setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    void this.requestWakeLock();
  }

  /** Pede o bloqueio de tela; perdê-lo (aba oculta, economia de energia) é mostrado ao operador. */
  private async requestWakeLock(): Promise<void> {
    if (this.disposed || !('wakeLock' in navigator) || this.wakeSentinel || document.visibilityState !== 'visible') return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (this.disposed) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      this.wakeSentinel = sentinel;
      this.setWakeLock('active');
      sentinel.addEventListener('release', () => {
        if (this.wakeSentinel === sentinel) this.wakeSentinel = null;
        this.setWakeLock('released');
      });
    } catch {
      this.setWakeLock('released');
    }
  }

  private setWakeLock(state: WakeLockState): void {
    if (this.disposed || this.wakeLock === state) return;
    this.wakeLock = state;
    this.notify();
  }

  private readonly onVisibility = () => {
    // Aba que volta a ficar visível reconcilia a posição com o tempo real.
    this.checkSuspension();
    this.engine.reconcile();
    if (document.visibilityState === 'hidden') this.flushCheckpoint();
    else void this.requestWakeLock();
  };

  private checkSuspension(): void {
    if (this.suspension.beat(Date.now())) this.engine.notifySuspension();
  }

  private readonly onPageHide = () => this.flushCheckpoint();

  private tick(): void {
    // Batimento muito atrasado: o dispositivo dormiu. A sessão volta em pausa, com a faixa parada.
    this.checkSuspension();
    // O despertador do motor pode ter sido adiado pelo navegador; esta é a segunda verificação.
    this.engine.reconcile();
    const sequence = this.engine.getState().sequenceNumber;
    this.channel?.post(this.link.heartbeatMessage(sequence));
    const now = performance.now();
    if (this.engine.getState().status === 'running' && now - this.lastProgressAt >= PROGRESS_CHECKPOINT_MS) this.scheduleCheckpoint(0);
    const before = this.snapshot.link;
    const after = this.link.status(now);
    if (before.connection !== after.connection || before.armed !== after.armed || before.fontMissing !== after.fontMissing || before.confirmedSequence !== after.confirmedSequence || before.windows !== after.windows) this.notify();
  }

  private onEngineChange(): void {
    const state = this.visualState();
    this.publishedAt.set(state.sequenceNumber, performance.now());
    if (this.publishedAt.size > 200) this.publishedAt.delete(this.publishedAt.keys().next().value as number);
    this.channel?.post(this.link.stateMessage(state));
    if (state.rotation !== this.lastRotation) {
      this.lastRotation = state.rotation;
      void this.storage.saveRotation(state.rotation).catch(() => undefined);
    }
    this.scheduleCheckpoint(CHECKPOINT_DEBOUNCE_MS);
    this.notify();
  }

  private onMessage(message: unknown): void {
    const now = performance.now();
    const { hello, command } = this.link.receive(message, now);
    if (hello) this.channel?.post(this.link.snapshotMessage(this.visualState()));
    // Comando de uma saída com controles: validado, deduplicado e executado aqui, no único motor.
    if (command) this.engine.execute(command);
    const status = this.link.status(now);
    if (status.confirmedSequence !== null && status.confirmedSequence > this.confirmed) {
      this.confirmed = status.confirmedSequence;
      const sentAt = this.publishedAt.get(status.confirmedSequence);
      if (sentAt !== undefined) this.lastConfirmMs = now - sentAt;
    }
    this.notify();
  }

  private scheduleCheckpoint(delayMs: number): void {
    this.checkpointState = 'saving';
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = window.setTimeout(() => this.flushCheckpoint(), delayMs);
  }

  /** Grava agora o estado atual. As escritas saem em ordem; só a mais nova decide o indicador. */
  flushCheckpoint(): void {
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    const version = ++this.writeVersion;
    const checkpoint = this.engine.checkpoint();
    this.lastProgressAt = performance.now();
    this.writing = this.writing
      .then(() => this.storage.saveCheckpoint(checkpoint))
      .then(
        () => this.settle(version, 'saved'),
        () => this.settle(version, 'memory-only'),
      );
  }

  private settle(version: number, state: CheckpointState): void {
    if (version !== this.writeVersion || this.checkpointTimer !== null) return;
    this.checkpointState = state;
    this.notify();
  }

  /** Espera as gravações de checkpoint em andamento. */
  async settled(): Promise<void> {
    if (this.checkpointTimer !== null) this.flushCheckpoint();
    await this.writing;
  }

  execute(command: OperatorCommand): CommandResult {
    return this.engine.execute(command);
  }

  getSnapshot = (): ControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Avisa a projeção de que a sessão acabou; com `nextSessionId`, ela passa a esperar a próxima. */
  announceEnd(nextSessionId?: Uuid): void {
    this.channel?.post(nextSessionId ? this.link.handoffMessage(nextSessionId) : this.link.endedMessage());
  }

  dispose(): void {
    this.disposed = true;
    void this.wakeSentinel?.release().catch(() => undefined);
    this.wakeSentinel = null;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.unsubscribe?.();
    this.engine.dispose();
    // O player é único e morre com o controlador: nenhuma faixa continua tocando sem painel.
    this.transport?.dispose();
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}
