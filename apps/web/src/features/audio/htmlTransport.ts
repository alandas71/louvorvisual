import { AudioPlayBlockedError, AudioSeekError, type AudioFailure, type AudioTransport, type AudioTransportEvent } from '@louvorvisual/presentation';
import type { AudioProbe } from '@/local';

const SEEK_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 15_000;

type PendingSeek = { resolve: (positionMs: number) => void; reject: (error: Error) => void; timer: number };

/**
 * Player único da sessão na web: um `HTMLAudioElement` na janela do operador,
 * lendo os bytes locais por uma URL `blob:` criada neste contexto. O navegador
 * busca o arquivo em fluxo; ele não é decodificado inteiro na memória. A janela
 * de projeção nunca cria um destes.
 */
export class HtmlAudioTransport implements AudioTransport {
  readonly element: HTMLAudioElement;
  private readonly url: string;
  private readonly listeners = new Set<(event: AudioTransportEvent) => void>();
  private pendingSeek: PendingSeek | null = null;
  private disposed = false;

  constructor(blob: Blob) {
    this.url = URL.createObjectURL(blob);
    const element = document.createElement('audio');
    element.preload = 'auto';
    element.hidden = true;
    element.dataset.testid = 'session-audio';
    element.src = this.url;
    this.element = element;
    document.body.append(element);

    element.addEventListener('playing', () => this.emit({ type: 'playing' }));
    element.addEventListener('pause', () => {
      // No fim da gravação o navegador também dispara `pause`; quem vale é `ended`.
      if (!element.ended) this.emit({ type: 'paused' });
    });
    element.addEventListener('waiting', () => {
      if (!element.paused) this.emit({ type: 'waiting' });
    });
    element.addEventListener('timeupdate', () => this.emit({ type: 'time' }));
    element.addEventListener('ended', () => this.emit({ type: 'ended' }));
    element.addEventListener('seeked', () => this.settleSeek());
    element.addEventListener('error', () => {
      this.failSeek(new AudioSeekError('failed'));
      this.emit({ type: 'error', reason: failureOf(element.error) });
    });
  }

  private emit(event: AudioTransportEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Espera os metadados; devolve a duração em ms ou rejeita se o navegador não lê o arquivo. */
  ready(): Promise<number> {
    const { element } = this;
    return new Promise<number>((resolve, reject) => {
      const done = () => {
        cleanup();
        if (Number.isFinite(element.duration) && element.duration > 0) resolve(element.duration * 1000);
        else reject(new Error('Duração desconhecida.'));
      };
      const failed = () => {
        cleanup();
        reject(new Error('O navegador não conseguiu ler o áudio.'));
      };
      const timer = window.setTimeout(failed, PROBE_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timer);
        element.removeEventListener('loadedmetadata', done);
        element.removeEventListener('error', failed);
      };
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) done();
      else if (element.error) failed();
      else {
        element.addEventListener('loadedmetadata', done);
        element.addEventListener('error', failed);
      }
    });
  }

  durationMs(): number | null {
    return Number.isFinite(this.element.duration) ? this.element.duration * 1000 : null;
  }

  positionMs(): number {
    return this.element.currentTime * 1000;
  }

  isPlaying(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  async play(): Promise<void> {
    try {
      await this.element.play();
    } catch (error) {
      // AbortError: um pause() chegou antes de a reprodução começar; não é falha.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw new AudioPlayBlockedError();
      throw error;
    }
  }

  pause(): void {
    this.element.pause();
  }

  private settleSeek(): void {
    const pending = this.pendingSeek;
    if (!pending) return;
    this.pendingSeek = null;
    window.clearTimeout(pending.timer);
    pending.resolve(this.element.currentTime * 1000);
  }

  private failSeek(error: Error): void {
    const pending = this.pendingSeek;
    if (!pending) return;
    this.pendingSeek = null;
    window.clearTimeout(pending.timer);
    pending.reject(error);
  }

  seek(positionMs: number): Promise<number> {
    // Só a intenção mais recente espera confirmação.
    this.failSeek(new AudioSeekError('superseded'));
    return new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => this.failSeek(new AudioSeekError('timeout')), SEEK_TIMEOUT_MS);
      this.pendingSeek = { resolve, reject, timer };
      try {
        this.element.currentTime = positionMs / 1000;
      } catch {
        this.failSeek(new AudioSeekError('failed'));
      }
    });
  }

  setVolume(volume: number): void {
    this.element.volume = Math.min(1, Math.max(0, volume));
  }

  subscribe(listener: (event: AudioTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.failSeek(new AudioSeekError('failed'));
    this.disposed = true;
    this.listeners.clear();
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this.element.remove();
    URL.revokeObjectURL(this.url);
  }
}

function failureOf(error: MediaError | null): AudioFailure {
  if (!error) return 'unknown';
  if (error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || error.code === MediaError.MEDIA_ERR_DECODE) return 'unplayable';
  if (error.code === MediaError.MEDIA_ERR_NETWORK) return 'missing';
  return 'unknown';
}

/**
 * Tentativa de carregar os metadados de um arquivo, sem tocar: devolve a
 * duração em ms, ou `null` se este navegador não consegue reproduzi-lo.
 */
export const probeAudio: AudioProbe = (blob) =>
  new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(blob);
    const element = document.createElement('audio');
    element.preload = 'metadata';
    const finish = (durationMs: number | null) => {
      window.clearTimeout(timer);
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
      resolve(durationMs);
    };
    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    element.addEventListener('loadedmetadata', () => finish(Number.isFinite(element.duration) && element.duration > 0 ? element.duration * 1000 : null), { once: true });
    element.addEventListener('error', () => finish(null), { once: true });
    element.src = url;
  });

/** Espaço livre estimado para o aplicativo; `null` quando o navegador não informa. */
export async function estimateFreeSpace(): Promise<number | null> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (estimate?.quota === undefined || estimate.usage === undefined) return null;
  return Math.max(0, estimate.quota - estimate.usage);
}

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** mm:ss para posições e durações de faixa. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
