import type { Uuid } from '@louvorvisual/domain';
import type { ControlsState, OperatorCommand, OutputFrame } from './engine';
import type { Rotation } from './renderer';

/** Nome do canal local entre janelas da mesma origem. Não conecta computadores. */
export const PRESENTATION_CHANNEL = 'lv-presentation';
export const HEARTBEAT_INTERVAL_MS = 1000;
/** Sem confirmação por este tempo, o outro lado é considerado ausente. */
export const CONNECTION_TIMEOUT_MS = 3000;

/** Estado visual completo: reenviá-lo sempre deixa a saída correta. */
export type VisualState = {
  sequenceNumber: number;
  frame: OutputFrame;
  rotation: Rotation;
  controls: ControlsState;
};

export type SessionInfo = { title: string; artist: string | null };

type Envelope = { sessionId: Uuid; generation: number };

export type ChannelMessage =
  | { type: 'PROJECTION_HELLO'; sessionId: Uuid; windowId: string }
  | (Envelope & { type: 'SESSION_SNAPSHOT'; info: SessionInfo; state: VisualState })
  | (Envelope & { type: 'VISUAL_STATE'; state: VisualState })
  | (Envelope & { type: 'OPERATOR_COMMAND'; windowId: string; commandId: string; command: OperatorCommand })
  | (Envelope & { type: 'STATE_ACK'; windowId: string; sequenceNumber: number; armed: boolean; fontMissing: boolean })
  | (Envelope & { type: 'HEARTBEAT'; from: 'controller' | 'projection'; windowId: string | null; sequenceNumber: number; armed: boolean; fontMissing: boolean })
  | (Envelope & { type: 'SESSION_ENDED' })
  /** A sessão acabou porque o operador passou ao próximo louvor: a saída passa a esperar a sessão indicada. */
  | (Envelope & { type: 'SESSION_HANDOFF'; nextSessionId: Uuid });

/** Ações que uma saída com controles habilitados pode pedir ao controlador único. */
const PROJECTION_COMMANDS: ReadonlySet<OperatorCommand['type']> = new Set([
  'toggle',
  'next',
  'previous',
  'first',
  'goTo',
  'setMode',
  'setVisualMode',
  'setFrozen',
  'adjust',
  'resetAdjustment',
  'stepFontSize',
  'setDuration',
  'setRotation',
  'rotate',
  'undo',
  'restoreAppearance',
  // Faixa: o pedido vai ao player único do operador; a saída nunca toca nada.
  'audioToggle',
  'setVolume',
]);

/** Encerrar, parar e publicar texto ficam só na área do operador. */
export function isProjectionCommandAllowed(command: unknown): command is OperatorCommand {
  if (typeof command !== 'object' || command === null) return false;
  const type = (command as { type?: unknown }).type;
  return typeof type === 'string' && PROJECTION_COMMANDS.has(type as OperatorCommand['type']);
}

function isMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { type, sessionId } = value as { type?: unknown; sessionId?: unknown };
  return typeof type === 'string' && typeof sessionId === 'string';
}

// ── lado da janela pública ───────────────────────────────────────────────

export type ReceiverStatus = 'waiting' | 'live' | 'ended';

export type ReceiverState = {
  status: ReceiverStatus;
  generation: number | null;
  info: SessionInfo | null;
  visual: VisualState | null;
};

/**
 * Regras da saída pública, sem DOM: aceita apenas a sua sessão, a geração de
 * controlador mais nova e sequências que não voltam no tempo. Não tem relógio
 * de slides nem áudio; só mostra o último estado confirmado.
 */
export class ProjectionReceiver {
  private state: ReceiverState = { status: 'waiting', generation: null, info: null, visual: null };
  private lastControllerAt: number | null = null;
  private commandCounter = 0;
  armed = false;
  /** A janela não conseguiu carregar a fonte do slide que está desenhando; só o operador é avisado. */
  fontMissing = false;

  constructor(
    readonly sessionId: Uuid,
    readonly windowId: string,
  ) {}

  getState(): ReceiverState {
    return this.state;
  }

  hello(): ChannelMessage {
    return { type: 'PROJECTION_HELLO', sessionId: this.sessionId, windowId: this.windowId };
  }

  /** O controlador deixou de dar sinal: a imagem fica, os comandos param. */
  controllerLost(now: number): boolean {
    return this.state.status === 'live' && (this.lastControllerAt === null || now - this.lastControllerAt > CONNECTION_TIMEOUT_MS);
  }

  /** Confirmação da sequência mais recente; a janela a envia depois de desenhar. */
  acknowledge(): ChannelMessage | null {
    const { generation, visual } = this.state;
    if (generation === null || !visual) return null;
    return { type: 'STATE_ACK', sessionId: this.sessionId, generation, windowId: this.windowId, sequenceNumber: visual.sequenceNumber, armed: this.armed, fontMissing: this.fontMissing };
  }

  heartbeat(): ChannelMessage | null {
    const { generation, visual } = this.state;
    if (generation === null || this.state.status !== 'live') return null;
    return {
      type: 'HEARTBEAT',
      sessionId: this.sessionId,
      generation,
      from: 'projection',
      windowId: this.windowId,
      sequenceNumber: visual?.sequenceNumber ?? -1,
      armed: this.armed,
      fontMissing: this.fontMissing,
    };
  }

  /** Monta o pedido de um controle da saída; `null` enquanto não há controlador confirmado. */
  command(command: OperatorCommand, now: number): ChannelMessage | null {
    const { generation } = this.state;
    if (generation === null || this.state.status !== 'live' || this.controllerLost(now) || !isProjectionCommandAllowed(command)) return null;
    this.commandCounter += 1;
    return { type: 'OPERATOR_COMMAND', sessionId: this.sessionId, generation, windowId: this.windowId, commandId: `${this.windowId}:${this.commandCounter}`, command };
  }

  receive(raw: unknown, now: number): { changed: boolean; reply: ChannelMessage[]; handoffTo?: Uuid } {
    const ignored = { changed: false, reply: [] };
    if (!isMessage(raw) || raw.sessionId !== this.sessionId) return ignored;
    if (raw.type !== 'SESSION_SNAPSHOT' && raw.type !== 'VISUAL_STATE' && raw.type !== 'HEARTBEAT' && raw.type !== 'SESSION_ENDED' && raw.type !== 'SESSION_HANDOFF') return ignored;
    if (raw.type === 'HEARTBEAT' && raw.from !== 'controller') return ignored;
    const current = this.state.generation;
    // Controlador antigo (por exemplo, uma aba que ficou para trás) não manda mais.
    if (current !== null && raw.generation < current) return ignored;
    // O fim é definitivo para aquele controlador: uma resposta atrasada dele não
    // devolve o slide à tela. Só um controlador mais novo reabre a saída.
    if (this.state.status === 'ended' && raw.generation === current) return ignored;

    if (raw.type === 'SESSION_ENDED' || raw.type === 'SESSION_HANDOFF') {
      this.state = { status: 'ended', generation: raw.generation, info: this.state.info, visual: null };
      this.lastControllerAt = null;
      // Fica preta até o controlador da próxima sessão responder; quem troca de sessão é a janela.
      const handoffTo = raw.type === 'SESSION_HANDOFF' && typeof raw.nextSessionId === 'string' ? raw.nextSessionId : undefined;
      return { changed: true, reply: [], handoffTo };
    }
    if (raw.type === 'HEARTBEAT') {
      if (current === null || raw.generation !== current) return { changed: false, reply: [this.hello()] };
      this.lastControllerAt = now;
      // Perdeu alguma troca: pede o estado completo em vez de adivinhar.
      const behind = (this.state.visual?.sequenceNumber ?? -1) < raw.sequenceNumber;
      return { changed: false, reply: behind ? [this.hello()] : [] };
    }

    const newer = current === null || raw.generation > current;
    if (raw.type === 'VISUAL_STATE' && (newer || this.state.status !== 'live')) {
      // Estado solto de um controlador que esta janela ainda não conhece.
      return { changed: false, reply: [this.hello()] };
    }
    this.lastControllerAt = now;
    const previous = this.state.visual?.sequenceNumber ?? -1;
    if (!newer && raw.state.sequenceNumber < previous) return ignored;
    const changed = newer || raw.state.sequenceNumber !== previous || this.state.status !== 'live';
    this.state = {
      status: 'live',
      generation: raw.generation,
      info: raw.type === 'SESSION_SNAPSHOT' ? raw.info : this.state.info,
      visual: raw.state,
    };
    const ack = this.acknowledge();
    return { changed, reply: ack ? [ack] : [] };
  }
}

// ── lado do operador ─────────────────────────────────────────────────────

export type ProjectionConnection = 'none' | 'connected' | 'lost';

export type LinkStatus = {
  connection: ProjectionConnection;
  windows: number;
  /** Alguma janela conectada já foi armada pelo operador. */
  armed: boolean;
  /** Alguma janela conectada está desenhando com a fonte de reserva porque o arquivo falhou. */
  fontMissing: boolean;
  /** Menor sequência confirmada entre as janelas conectadas. */
  confirmedSequence: number | null;
};

type WindowRecord = { lastSeenAt: number; sequenceNumber: number; armed: boolean; fontMissing: boolean };

const DEDUPE_LIMIT = 500;

/** Regras do controlador para o canal: quem está conectado e quais comandos valem. */
export class ControllerLink {
  private readonly windows = new Map<string, WindowRecord>();
  private readonly seenCommands = new Set<string>();
  private everConnected = false;
  private ended = false;

  constructor(
    readonly sessionId: Uuid,
    readonly generation: number,
    readonly info: SessionInfo,
  ) {}

  snapshotMessage(state: VisualState): ChannelMessage {
    return { type: 'SESSION_SNAPSHOT', sessionId: this.sessionId, generation: this.generation, info: this.info, state };
  }

  stateMessage(state: VisualState): ChannelMessage {
    return { type: 'VISUAL_STATE', sessionId: this.sessionId, generation: this.generation, state };
  }

  heartbeatMessage(sequenceNumber: number): ChannelMessage {
    return { type: 'HEARTBEAT', sessionId: this.sessionId, generation: this.generation, from: 'controller', windowId: null, sequenceNumber, armed: false, fontMissing: false };
  }

  /** Fim desta sessão com indicação da próxima (próximo louvor do repertório). */
  handoffMessage(nextSessionId: Uuid): ChannelMessage {
    this.ended = true;
    return { type: 'SESSION_HANDOFF', sessionId: this.sessionId, generation: this.generation, nextSessionId };
  }

  /** Depois de anunciar o fim, este controlador não reenvia estado nem aceita comandos. */
  endedMessage(): ChannelMessage {
    this.ended = true;
    return { type: 'SESSION_ENDED', sessionId: this.sessionId, generation: this.generation };
  }

  /**
   * `hello`: reenviar o estado completo. `command`: executar no motor. Mensagem
   * de outra sessão, de outra geração ou comando repetido não produz nada.
   */
  receive(raw: unknown, now: number): { hello: boolean; command: OperatorCommand | null } {
    const nothing = { hello: false, command: null };
    if (this.ended || !isMessage(raw) || raw.sessionId !== this.sessionId) return nothing;
    if (raw.type === 'PROJECTION_HELLO') {
      if (typeof raw.windowId !== 'string') return nothing;
      this.touch(raw.windowId, now, -1, false, false);
      return { hello: true, command: null };
    }
    if (raw.type !== 'STATE_ACK' && raw.type !== 'HEARTBEAT' && raw.type !== 'OPERATOR_COMMAND') return nothing;
    if (raw.generation !== this.generation) return nothing;
    if (raw.type === 'HEARTBEAT') {
      if (raw.from !== 'projection' || raw.windowId === null) return nothing;
      this.touch(raw.windowId, now, raw.sequenceNumber, raw.armed, raw.fontMissing === true);
      return nothing;
    }
    if (raw.type === 'STATE_ACK') {
      this.touch(raw.windowId, now, raw.sequenceNumber, raw.armed, raw.fontMissing === true);
      return nothing;
    }
    if (typeof raw.commandId !== 'string' || this.seenCommands.has(raw.commandId) || !isProjectionCommandAllowed(raw.command)) return nothing;
    this.seenCommands.add(raw.commandId);
    if (this.seenCommands.size > DEDUPE_LIMIT) this.seenCommands.delete(this.seenCommands.values().next().value as string);
    const known = this.windows.get(raw.windowId);
    this.touch(raw.windowId, now, known?.sequenceNumber ?? -1, known?.armed ?? false, known?.fontMissing ?? false);
    return { hello: false, command: raw.command };
  }

  private touch(windowId: string, now: number, sequenceNumber: number, armed: boolean, fontMissing: boolean): void {
    this.everConnected = true;
    this.windows.set(windowId, { lastSeenAt: now, sequenceNumber, armed, fontMissing });
  }

  status(now: number): LinkStatus {
    const alive = [...this.windows.values()].filter((item) => now - item.lastSeenAt <= CONNECTION_TIMEOUT_MS);
    if (alive.length === 0) {
      return { connection: this.everConnected ? 'lost' : 'none', windows: 0, armed: false, fontMissing: false, confirmedSequence: null };
    }
    return {
      connection: 'connected',
      windows: alive.length,
      armed: alive.some((item) => item.armed),
      fontMissing: alive.some((item) => item.fontMissing),
      confirmedSequence: Math.min(...alive.map((item) => item.sequenceNumber)),
    };
  }
}

// ── atalhos ──────────────────────────────────────────────────────────────

/**
 * Atalhos do planejamento/05. Devolve `null` para teclas sem ação e para
 * combinações com modificadores; quem chama ignora campos de edição.
 */
export function shortcutCommand(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  controls: Pick<ControlsState, 'status' | 'capabilities' | 'visualMode' | 'frozen'>,
): OperatorCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowRight':
    case 'PageDown':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'PageUp':
      return { type: 'previous' };
    case 'Home':
      return { type: 'first' };
    case ' ':
    case 'Spacebar':
      // Sem faixa e sem duração atual no automático, Espaço não executa transporte.
      return controls.status === 'ready' || controls.capabilities.transport ? { type: 'toggle' } : null;
    case 'b':
    case 'B':
      return { type: 'setVisualMode', visualMode: controls.visualMode === 'black' ? 'normal' : 'black' };
    case 'l':
    case 'L':
      return { type: 'setVisualMode', visualMode: controls.visualMode === 'lyricsHidden' ? 'normal' : 'lyricsHidden' };
    case 'c':
    case 'C':
      return { type: 'setFrozen', frozen: !controls.frozen };
    default:
      return null;
  }
}
