import type { FirstVoiceRequest, FirstVoiceResponse } from './firstVoice.worker';
import { firstVoiceStorageKey } from './lyricsStart';

const SAMPLE_RATE = 16_000;
/** A letra entra no começo da música: não vale analisar a faixa inteira. */
const ANALYSIS_LIMIT_S = 240;

const pending = new Map<string, Promise<number | null>>();

function remembered(key: string): number | null | undefined {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return undefined;
    return stored === 'none' ? null : Number(stored);
  } catch {
    return undefined;
  }
}

function remember(key: string, value: number | null): void {
  try {
    window.localStorage.setItem(key, value === null ? 'none' : String(value));
  } catch {
    // Sem armazenamento, a próxima sessão analisa de novo.
  }
}

async function analyze(blob: Blob, lyrics: string): Promise<number | null> {
  // Decodificar em um contexto de 16 kHz já entrega o áudio na taxa que o modelo usa.
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
  const length = Math.min(decoded.length, ANALYSIS_LIMIT_S * SAMPLE_RATE);
  const samples = new Float32Array(length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i++) samples[i] = (samples[i] as number) + (data[i] as number) / decoded.numberOfChannels;
  }

  // O reconhecimento leva de segundos a minutos: roda fora da janela, para o painel não travar.
  const worker = new Worker(new URL('./firstVoice.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<number | null>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent<FirstVoiceResponse>) => (event.data.ok ? resolve(event.data.startMs) : reject(new Error(event.data.message))));
      worker.addEventListener('error', (event) => reject(new Error(event.message)));
      const request: FirstVoiceRequest = { samples, lyrics };
      worker.postMessage(request, [samples.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Posição (ms, no arquivo) em que a letra do louvor começa a ser cantada na
 * faixa, ou `null` se ela não foi reconhecida. A faixa é transcrita por
 * reconhecimento de fala e comparada com a letra, então a introdução
 * instrumental não conta. O resultado fica guardado por arquivo e letra; o
 * modelo só é baixado quando há uma faixa nova para analisar. Rejeita se a
 * análise não puder rodar (sem rede para baixar o modelo, por exemplo).
 */
export function firstVoiceMs(blob: Blob, sha256: string, lyrics: string): Promise<number | null> {
  const key = firstVoiceStorageKey(sha256, lyrics);
  const known = remembered(key);
  if (known !== undefined) return Promise.resolve(known);
  let running = pending.get(key);
  if (!running) {
    running = analyze(blob, lyrics).then(
      (value) => {
        remember(key, value);
        return value;
      },
      (error: unknown) => {
        pending.delete(key);
        throw error;
      },
    );
    pending.set(key, running);
  }
  return running;
}
