import type { AudioStateEvent } from '@louvorvisual/contracts';
import { AudioPlayBlockedError, AudioSeekError, type AudioTransport, type AudioTransportEvent } from '@louvorvisual/presentation';
import { HostError, type HostClient } from '../host/client';

type Clock = { now(): number };

/**
 * Player único da sessão no projetor: o player nativo do host, visto pelo
 * motor pela mesma interface da web. O bundle não toca nada nem recebe bytes;
 * só pede transporte e acompanha a posição que o host confirma.
 *
 * `positionMs()` precisa responder na hora, então entre dois avisos do host a
 * posição é projetada pelo relógio monotônico a partir do último valor
 * confirmado — e só enquanto o host disse que está tocando.
 */
export class HostAudioTransport implements AudioTransport {
  private readonly listeners = new Set<(event: AudioTransportEvent) => void>();
  private readonly unsubscribe: () => void;
  private base = 0;
  /** Instante em que `base` foi confirmada com a faixa andando; `null` parada. */
  private anchor: number | null = null;
  private wanted = false;
  private seekGeneration = 0;
  private disposed = false;

  constructor(
    private readonly host: HostClient,
    private readonly clock: Clock,
    private readonly duration: number,
  ) {
    this.unsubscribe = host.on('audio.state', (event) => this.onHost(event));
  }

  private emit(event: AudioTransportEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(event);
  }

  private confirm(positionMs: number, moving: boolean): void {
    this.base = Math.min(this.duration, Math.max(0, positionMs));
    this.anchor = moving ? this.clock.now() : null;
  }

  private onHost(event: AudioStateEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'playing':
        // Confirmação atrasada de um play que já foi desfeito por uma pausa: não reabre.
        if (!this.wanted) return;
        this.confirm(event.positionMs, true);
        this.emit({ type: 'playing' });
        return;
      case 'time':
        this.confirm(event.positionMs, this.wanted && this.anchor !== null);
        this.emit({ type: 'time' });
        return;
      case 'waiting':
        this.confirm(event.positionMs, false);
        if (this.wanted) this.emit({ type: 'waiting' });
        return;
      case 'paused':
        // A pausa pedida por aqui já foi publicada na hora; só a de fora é novidade.
        if (!event.external) {
          if (!this.wanted) this.confirm(event.positionMs, false);
          return;
        }
        this.confirm(event.positionMs, false);
        if (!this.wanted) return;
        this.wanted = false;
        this.emit({ type: 'paused' });
        return;
      case 'ended':
        this.confirm(event.positionMs, false);
        this.wanted = false;
        this.emit({ type: 'ended' });
        return;
      case 'error':
        this.confirm(event.positionMs, false);
        this.wanted = false;
        this.emit({ type: 'error', reason: event.reason ?? 'unknown' });
        return;
    }
  }

  durationMs(): number {
    return this.duration;
  }

  positionMs(): number {
    const position = this.base + (this.anchor === null ? 0 : this.clock.now() - this.anchor);
    return Math.min(this.duration, Math.max(0, position));
  }

  isPlaying(): boolean {
    return this.wanted;
  }

  async play(): Promise<void> {
    if (this.disposed) throw new Error('Player encerrado.');
    this.wanted = true;
    try {
      await this.host.request('audio.play', {});
    } catch (error) {
      this.wanted = false;
      this.anchor = null;
      if (error instanceof HostError && error.code === 'blocked') throw new AudioPlayBlockedError();
      throw error;
    }
  }

  pause(): void {
    if (this.disposed || !this.wanted) return;
    this.base = this.positionMs();
    this.anchor = null;
    this.wanted = false;
    this.emit({ type: 'paused' });
    this.host.request('audio.pause', {}).then(
      (result) => {
        if (!this.wanted && !this.disposed) this.confirm(result.positionMs, false);
      },
      () => undefined,
    );
  }

  async seek(positionMs: number): Promise<number> {
    const generation = ++this.seekGeneration;
    // Até o host confirmar, a posição não é projetada a partir do ponto antigo.
    this.base = this.positionMs();
    this.anchor = null;
    let confirmed: number;
    try {
      confirmed = (await this.host.request('audio.seek', { positionMs: Math.max(0, Math.round(positionMs)) })).positionMs;
    } catch {
      throw new AudioSeekError(generation === this.seekGeneration ? 'failed' : 'superseded');
    }
    if (generation !== this.seekGeneration) throw new AudioSeekError('superseded');
    this.confirm(confirmed, false);
    return confirmed;
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    void this.host.request('audio.setVolume', { volume: Math.min(1, Math.max(0, volume)) }).catch(() => undefined);
  }

  subscribe(listener: (event: AudioTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Solta o player nativo; nenhuma faixa continua tocando sem sessão. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
    void this.host.request('audio.release', {}).catch(() => undefined);
  }
}
