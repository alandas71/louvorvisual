import type { RecoverableSession, SessionContext } from '@louvorvisual/contracts';
import type { Uuid } from '@louvorvisual/domain';
import {
  isRotation,
  prepareSnapshot,
  PresentationEngine,
  SNAPSHOT_SCHEMA_VERSION,
  SUSPENSION_THRESHOLD_MS,
  type CommandResult,
  type EngineClock,
  type EngineView,
  type OperatorCommand,
  type Rotation,
  type SessionCheckpoint,
  type SessionSnapshot,
  type SnapshotIssue,
  type SnapshotWarning,
} from '@louvorvisual/presentation';
import { HostError, type HostClient } from '../host/client';
import { HostAudioTransport } from './hostAudio';

/** Relógio do WebView: `performance.now()` é monotônico neste processo. */
export const browserClock: EngineClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export function newId(): Uuid {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Origem sem `randomUUID` (WebView antigo): mesma forma, a partir de bytes aleatórios.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "Guardado nesta sessão" só depois de o host confirmar a gravação. */
export type CheckpointState = 'saved' | 'saving' | 'memory-only';

export type SessionView = { view: EngineView; checkpoint: CheckpointState };

const CHECKPOINT_DEBOUNCE_MS = 150;
const PROGRESS_CHECKPOINT_MS = 5000;
const HEARTBEAT_MS = 1000;

export type ProjectorSessionOptions = {
  host: HostClient;
  snapshot: SessionSnapshot;
  sessionId: Uuid;
  checkpoint: SessionCheckpoint | null;
  rotation: Rotation;
  transport: HostAudioTransport | null;
  onRotation?: (rotation: Rotation) => void;
};

/**
 * Controlador único da sessão no projetor: motor, player e saída na mesma
 * tela (planejamento/21). Não há janela de projeção nem canal — o que o motor
 * publica é desenhado aqui mesmo. Checkpoint e player ficam no host.
 */
export class ProjectorSession {
  readonly engine: PresentationEngine;
  readonly sessionId: Uuid;
  /** Comandos entregues ao motor, na ordem (diagnóstico e testes de duplicidade). */
  readonly commandLog: string[] = [];
  private readonly host: HostClient;
  private readonly transport: HostAudioTransport | null;
  private readonly onRotation?: (rotation: Rotation) => void;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionView;
  private checkpointState: CheckpointState = 'saved';
  private checkpointTimer: number | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeVersion = 0;
  private heartbeat: number | null = null;
  private lastBeat = Date.now();
  private lastProgressAt = 0;
  private lastRotation: Rotation;
  private unsubscribes: (() => void)[] = [];
  private disposed = false;

  constructor(options: ProjectorSessionOptions) {
    this.host = options.host;
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.onRotation = options.onRotation;
    this.engine = new PresentationEngine({
      snapshot: options.snapshot,
      clock: browserClock,
      sessionId: options.sessionId,
      rotation: options.rotation,
      checkpoint: options.checkpoint ?? undefined,
      transport: options.transport,
    });
    this.lastRotation = this.engine.getView().rotation;
    this.snapshot = this.read();
  }

  private read(): SessionView {
    return { view: this.engine.getView(), checkpoint: this.checkpointState };
  }

  private notify(): void {
    if (this.disposed) return;
    this.snapshot = this.read();
    for (const listener of [...this.listeners]) listener();
  }

  start(): void {
    this.unsubscribes.push(
      this.engine.subscribe(() => this.onEngineChange()),
      // Home, outro aplicativo, suspensão: pausa, grava e espera o operador (planejamento/21).
      this.host.on('host.lifecycle', ({ state }) => {
        if (state === 'background') this.suspend();
        else this.lastBeat = Date.now();
      }),
    );
    this.heartbeat = window.setInterval(() => this.tick(), HEARTBEAT_MS);
    void this.host.request('host.setKeepAwake', { on: true }).catch(() => undefined);
  }

  private suspend(): void {
    if (this.engine.getState().status === 'running') this.engine.execute({ type: 'pause' });
    this.flushCheckpoint();
  }

  private tick(): void {
    // Batimento muito atrasado: o aparelho dormiu. A sessão volta em pausa, sem pular slides vencidos.
    const now = Date.now();
    const gap = now - this.lastBeat;
    this.lastBeat = now;
    if (gap > SUSPENSION_THRESHOLD_MS) this.engine.notifySuspension();
    this.engine.reconcile();
    if (this.engine.getState().status === 'running' && performance.now() - this.lastProgressAt >= PROGRESS_CHECKPOINT_MS) this.scheduleCheckpoint(0);
  }

  private onEngineChange(): void {
    const { rotation } = this.engine.getView();
    if (rotation !== this.lastRotation) {
      this.lastRotation = rotation;
      this.onRotation?.(rotation);
    }
    this.scheduleCheckpoint(CHECKPOINT_DEBOUNCE_MS);
    this.notify();
  }

  private scheduleCheckpoint(delayMs: number): void {
    this.checkpointState = 'saving';
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = window.setTimeout(() => this.flushCheckpoint(), delayMs);
  }

  /** Grava agora o estado atual. As escritas saem em ordem; só a mais nova decide o indicador. */
  flushCheckpoint(): void {
    if (this.disposed) return;
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    const version = ++this.writeVersion;
    const checkpoint = JSON.parse(JSON.stringify(this.engine.checkpoint())) as Record<string, unknown>;
    this.lastProgressAt = performance.now();
    this.writing = this.writing
      .then(() => this.host.request('session.saveCheckpoint', { sessionId: this.sessionId, checkpoint }))
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

  /** Único ponto de entrada de comandos da interface para o motor. */
  execute(command: OperatorCommand): CommandResult {
    const result = this.engine.execute(command);
    this.commandLog.push(result.ok ? command.type : `${command.type}!${result.reason}`);
    if (this.commandLog.length > 500) this.commandLog.splice(0, 100);
    return result;
  }

  /** Tempo que falta no slide atual; lido na hora, não é estado publicado. */
  remainingMs(): number | null {
    return this.engine.remainingMs();
  }

  getSnapshot = (): SessionView => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Para tudo. O player nativo é solto junto: nenhuma faixa continua tocando sem sessão. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.checkpointTimer !== null) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.engine.dispose();
    this.transport?.dispose();
    this.listeners.clear();
    void this.host.request('host.setKeepAwake', { on: false }).catch(() => undefined);
  }
}

export type OpenFailure = { kind: 'not-found' } | { kind: 'host'; code: string } | { kind: 'snapshot'; issues: SnapshotIssue[] } | { kind: 'unrecoverable' };

export type OpenedSession = {
  session: ProjectorSession;
  title: string;
  artist: string | null;
  warnings: SnapshotWarning[];
  /** A faixa escolhida não está neste aparelho, ou o player não conseguiu abri-la. */
  audioUnavailable: boolean;
  context: SessionContext;
  recovered: boolean;
};

export type OpenResult = { ok: true; opened: OpenedSession } | { ok: false; failure: OpenFailure };

type Common = { host: HostClient; rotation: Rotation; onRotation: (rotation: Rotation) => void };

async function loadTransport(host: HostClient, snapshot: SessionSnapshot): Promise<HostAudioTransport | null> {
  const { audio } = snapshot;
  if (!audio) return null;
  try {
    const { durationMs } = await host.request('audio.load', { assetId: audio.assetId, sha256: audio.sha256 });
    return new HostAudioTransport(host, browserClock, durationMs > 0 ? durationMs : audio.durationMs);
  } catch {
    return null;
  }
}

/**
 * Prepara a sessão de um arranjo: documentos do host (já validados pelo
 * contrato), base da sessão pelo mesmo `prepareSnapshot` da web, player e
 * gravação da base. Nada começa a tocar.
 */
export async function openSession(common: Common, arrangementId: Uuid, context: SessionContext): Promise<OpenResult> {
  const { host } = common;
  let presentable;
  try {
    presentable = await host.request('library.getPresentable', { arrangementId });
  } catch (error) {
    const code = error instanceof HostError ? error.code : 'failed';
    return { ok: false, failure: code === 'not-found' ? { kind: 'not-found' } : { kind: 'host', code } };
  }
  // Notas são privadas do operador e esta tela é a projeção: não entram na sessão.
  const song = { ...presentable.song, notes: '' };
  const prepared = prepareSnapshot({
    id: newId(),
    now: new Date().toISOString(),
    song,
    arrangement: presentable.arrangement,
    songGeneration: presentable.songGeneration,
    arrangementGeneration: presentable.arrangementGeneration,
    audio: presentable.audio,
  });
  if (!prepared.ok) return { ok: false, failure: { kind: 'snapshot', issues: prepared.issues } };
  const { snapshot } = prepared;
  const sessionId = newId();
  const transport = await loadTransport(host, snapshot);
  try {
    await host.request('session.create', { sessionId, snapshot: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>, context });
  } catch (error) {
    transport?.dispose();
    return { ok: false, failure: { kind: 'host', code: error instanceof HostError ? error.code : 'failed' } };
  }
  const session = new ProjectorSession({ ...common, snapshot, sessionId, checkpoint: null, transport });
  return {
    ok: true,
    opened: { session, title: song.title, artist: song.artist, warnings: prepared.warnings, audioUnavailable: presentable.audioMissing || (snapshot.audio !== null && transport === null), context, recovered: false },
  };
}

function isSnapshot(value: unknown): value is SessionSnapshot {
  const snapshot = value as Partial<SessionSnapshot> | null;
  return (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    typeof snapshot.id === 'string' &&
    typeof snapshot.song?.title === 'string' &&
    Array.isArray(snapshot.occurrences) &&
    snapshot.occurrences.length > 0 &&
    snapshot.occurrences.every((occurrence) => typeof occurrence?.id === 'string' && typeof occurrence.text === 'string' && typeof occurrence.style?.palette?.backgroundColor === 'string')
  );
}

function isCheckpoint(value: unknown, snapshot: SessionSnapshot, sessionId: Uuid): value is SessionCheckpoint {
  const checkpoint = value as Partial<SessionCheckpoint> | null;
  return (
    typeof checkpoint === 'object' &&
    checkpoint !== null &&
    checkpoint.sessionId === sessionId &&
    checkpoint.snapshotId === snapshot.id &&
    typeof checkpoint.currentOccurrenceId === 'string' &&
    typeof checkpoint.overrides === 'object' &&
    checkpoint.overrides !== null &&
    Array.isArray(checkpoint.undo) &&
    isRotation(checkpoint.rotation)
  );
}

/** Título da sessão interrompida, para a pergunta de recuperação; `null` se a base não é legível. */
export function recoverableTitle(stored: RecoverableSession): string | null {
  return isSnapshot(stored.snapshot) ? stored.snapshot.song.title : null;
}

/**
 * Retoma uma sessão interrompida a partir da base e do último checkpoint
 * confirmados pelo host. O motor volta sempre em pausa, com a faixa parada.
 */
export async function recoverSession(common: Common, stored: RecoverableSession): Promise<OpenResult> {
  if (!isSnapshot(stored.snapshot)) return { ok: false, failure: { kind: 'unrecoverable' } };
  const snapshot: SessionSnapshot = { ...stored.snapshot, song: { ...stored.snapshot.song, notes: '' } };
  const checkpoint = isCheckpoint(stored.checkpoint, snapshot, stored.sessionId) ? stored.checkpoint : null;
  const transport = await loadTransport(common.host, snapshot);
  const session = new ProjectorSession({ ...common, snapshot, sessionId: stored.sessionId, checkpoint, transport, rotation: checkpoint?.rotation ?? common.rotation });
  return {
    ok: true,
    opened: { session, title: snapshot.song.title, artist: snapshot.song.artist, warnings: [], audioUnavailable: snapshot.audio !== null && transport === null, context: stored.context, recovered: true },
  };
}
