/**
 * Contrato do player único da sessão (planejamento/06). Na web é um
 * `HTMLAudioElement` na janela do operador; no APK, um adaptador do player
 * nativo. O motor só conhece esta interface: posição efetiva, eventos e seek
 * confirmado, iguais nos dois clientes.
 */
export type AudioFailure = 'missing' | 'unplayable' | 'unknown';

export type AudioTransportEvent =
  /** A reprodução começou ou voltou de fato a andar. */
  | { type: 'playing' }
  | { type: 'paused' }
  /** Parada inesperada (buffer, dispositivo): a posição deixou de avançar sem pausa pedida. */
  | { type: 'waiting' }
  /** A posição avançou; quem acompanha a faixa relê `positionMs()`. */
  | { type: 'time' }
  | { type: 'ended' }
  | { type: 'error'; reason: AudioFailure };

export interface AudioTransport {
  /** Duração da gravação; `null` enquanto os metadados não foram lidos. */
  durationMs(): number | null;
  /** Posição efetiva do player, a única fonte de tempo da faixa. */
  positionMs(): number;
  /** Há reprodução pedida e não pausada nem terminada. */
  isPlaying(): boolean;
  /** Rejeita quando o cliente bloqueia a reprodução (`AudioPlayBlockedError`) ou a mídia falha. */
  play(): Promise<void>;
  pause(): void;
  /** Resolve com a posição confirmada pelo player; rejeita se o reposicionamento falhar ou for substituído por outro. */
  seek(positionMs: number): Promise<number>;
  /** 0 a 1. */
  setVolume(volume: number): void;
  subscribe(listener: (event: AudioTransportEvent) => void): () => void;
}

/** O cliente recusou tocar sem um gesto do usuário (política de autoplay). */
export class AudioPlayBlockedError extends Error {
  constructor() {
    super('A reprodução foi bloqueada até um gesto do usuário.');
    this.name = 'AudioPlayBlockedError';
  }
}

export class AudioSeekError extends Error {
  constructor(readonly reason: 'failed' | 'superseded' | 'timeout') {
    super(`Reposicionamento da faixa: ${reason}.`);
    this.name = 'AudioSeekError';
  }
}

type PendingSeek = { positionMs: number; resolve: (positionMs: number) => void; reject: (error: Error) => void };

/**
 * Transporte simulado para testes: a posição anda com o relógio informado e o
 * seek só é confirmado quando o teste manda (`confirmSeek`), como um player real.
 */
export class ManualTransport implements AudioTransport {
  private readonly listeners = new Set<(event: AudioTransportEvent) => void>();
  private base = 0;
  private anchor: number | null = null;
  private wanted = false;
  private pending: PendingSeek[] = [];
  /** Posições pedidas em `seek`, na ordem. */
  readonly seekLog: number[] = [];
  volume = 1;
  /** Próximas chamadas de `play()` são recusadas como autoplay bloqueado. */
  playBlocked = false;
  /** Confirma cada seek sozinho, na próxima microtarefa. */
  autoConfirm = true;

  constructor(
    private readonly clock: { now(): number },
    private readonly duration: number | null,
  ) {}

  private emit(event: AudioTransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  durationMs(): number | null {
    return this.duration;
  }

  positionMs(): number {
    const position = this.base + (this.anchor === null ? 0 : this.clock.now() - this.anchor);
    return this.duration === null ? position : Math.min(this.duration, position);
  }

  isPlaying(): boolean {
    return this.wanted;
  }

  play(): Promise<void> {
    if (this.playBlocked) return Promise.reject(new AudioPlayBlockedError());
    if (!this.wanted) {
      this.wanted = true;
      this.anchor = this.clock.now();
      this.emit({ type: 'playing' });
    }
    return Promise.resolve();
  }

  pause(): void {
    if (!this.wanted) return;
    this.base = this.positionMs();
    this.anchor = null;
    this.wanted = false;
    this.emit({ type: 'paused' });
  }

  seek(positionMs: number): Promise<number> {
    this.seekLog.push(positionMs);
    // Um pedido novo substitui o anterior ainda não confirmado.
    for (const previous of this.pending.splice(0)) previous.reject(new AudioSeekError('superseded'));
    const promise = new Promise<number>((resolve, reject) => this.pending.push({ positionMs, resolve, reject }));
    if (this.autoConfirm) void Promise.resolve().then(() => this.confirmSeek());
    return promise;
  }

  /** O player confirmou o reposicionamento pendente. */
  confirmSeek(): void {
    const seek = this.pending.shift();
    if (!seek) return;
    this.base = seek.positionMs;
    this.anchor = this.wanted ? this.clock.now() : null;
    seek.resolve(seek.positionMs);
  }

  failSeek(): void {
    this.pending.shift()?.reject(new AudioSeekError('failed'));
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  subscribe(listener: (event: AudioTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Entrega a posição atual, como o `timeupdate` do navegador; no fim da gravação, encerra. */
  tick(): void {
    if (this.wanted && this.duration !== null && this.positionMs() >= this.duration) {
      this.base = this.duration;
      this.anchor = null;
      this.wanted = false;
      this.emit({ type: 'ended' });
      return;
    }
    this.emit({ type: 'time' });
  }

  /** A posição para de avançar sem pausa pedida (buffer ou dispositivo). */
  stall(): void {
    this.base = this.positionMs();
    this.anchor = null;
    this.emit({ type: 'waiting' });
  }

  /** A reprodução volta a andar depois de uma parada inesperada. */
  unstall(): void {
    if (this.wanted && this.anchor === null) this.anchor = this.clock.now();
    this.emit({ type: 'playing' });
  }

  fail(reason: AudioFailure = 'unknown'): void {
    this.base = this.positionMs();
    this.anchor = null;
    this.wanted = false;
    this.emit({ type: 'error', reason });
  }

  /** Pausa vinda de fora do motor (tecla de mídia, sistema). */
  externalPause(): void {
    this.pause();
  }

  get pendingSeeks(): number {
    return this.pending.length;
  }
}
