import type { RemoteKey, RemoteKeyEvent } from '@louvorvisual/contracts';

/** O que o contexto em foco aceita de uma tecla mantida pressionada. */
export type RepeatPolicy =
  /** Apresentação limpa: um pressionamento, um comando. */
  | 'none'
  /** Listas, menus e campos de ajuste: as setas repetem para percorrer; OK e Voltar, nunca. */
  | 'directions';

export type InputContext = {
  repeat: RepeatPolicy;
  /** Identifica o contexto de foco; muda quando um menu abre ou fecha. */
  scope: number;
};

export type DropReason =
  /** Sequência já vista: a ponte entregou a mesma mensagem de novo. */
  | 'duplicate'
  /** Repetição automática onde o contexto só aceita o pressionamento inicial. */
  | 'repeat'
  /** A tecla continua pressionada desde um contexto anterior. */
  | 'held-across-contexts'
  /** Repetição acima do ritmo aceito. */
  | 'throttled';

export type KeyDecision = { command: RemoteKey } | { command: null; reason: DropReason | 'release' };

const DIRECTIONS: ReadonlySet<RemoteKey> = new Set(['up', 'down', 'left', 'right']);

/** Sem `up` nem repetição por este tempo, a tecla é dada como solta (um `up` pode se perder). */
export const HELD_EXPIRY_MS = 700;
/** Intervalo mínimo entre dois passos de uma seta mantida. */
export const REPEAT_INTERVAL_MS = 90;

type Held = { lastAt: number; scope: number; steppedAt: number };

/**
 * Transforma as teclas do host em comandos, no máximo um por pressionamento
 * (planejamento/21): descarta mensagens repetidas pela sequência, ignora a
 * repetição automática fora de listas e nunca deixa uma tecla mantida agir em
 * um contexto diferente daquele em que foi pressionada. Não conhece DOM nem
 * motor; quem chama informa o contexto de foco do momento.
 */
export class KeyNormalizer {
  private epoch: string | null = null;
  private lastSeq = -1;
  private readonly held = new Map<RemoteKey, Held>();
  readonly stats = { accepted: 0, released: 0, duplicate: 0, repeat: 0, 'held-across-contexts': 0, throttled: 0 };

  accept(event: RemoteKeyEvent, context: InputContext, now: number): KeyDecision {
    if (event.epoch !== this.epoch) {
      // O host reiniciou: a sequência recomeça e nenhuma tecla continua pressionada.
      this.epoch = event.epoch;
      this.lastSeq = -1;
      this.held.clear();
    }
    if (event.seq <= this.lastSeq) return this.drop('duplicate');
    this.lastSeq = event.seq;

    if (event.action === 'up') {
      this.held.delete(event.key);
      this.stats.released += 1;
      return { command: null, reason: 'release' };
    }

    const previous = this.held.get(event.key);
    const stillHeld = previous !== undefined && now - previous.lastAt < HELD_EXPIRY_MS;
    // `down` sem `up` antes também é repetição, mesmo que o host diga `repeat: 0`.
    if (event.repeat === 0 && !stillHeld) {
      this.held.set(event.key, { lastAt: now, scope: context.scope, steppedAt: now });
      this.stats.accepted += 1;
      return { command: event.key };
    }

    const held: Held = previous && stillHeld ? previous : { lastAt: now, scope: -1, steppedAt: now };
    held.lastAt = now;
    this.held.set(event.key, held);
    if (context.repeat !== 'directions' || !DIRECTIONS.has(event.key)) return this.drop('repeat');
    if (held.scope !== context.scope) return this.drop('held-across-contexts');
    if (now - held.steppedAt < REPEAT_INTERVAL_MS) return this.drop('throttled');
    held.steppedAt = now;
    this.stats.accepted += 1;
    return { command: event.key };
  }

  private drop(reason: DropReason): KeyDecision {
    this.stats[reason] += 1;
    return { command: null, reason };
  }
}
