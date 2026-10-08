/** Mesma versão de scripts/copy-vad-assets.mjs. */
const VAD_ASSETS = '/vad/v1/';
const SAMPLE_RATE = 16_000;
/** A primeira voz está no começo da música: não vale analisar a faixa inteira. */
const ANALYSIS_LIMIT_S = 240;
const STORAGE_PREFIX = 'lv:first-voice:v1:';

const pending = new Map<string, Promise<number | null>>();

function remembered(sha256: string): number | null | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + sha256);
    if (stored === null) return undefined;
    return stored === 'none' ? null : Number(stored);
  } catch {
    return undefined;
  }
}

function remember(sha256: string, value: number | null): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + sha256, value === null ? 'none' : String(value));
  } catch {
    // Sem armazenamento, a próxima sessão analisa de novo.
  }
}

async function analyze(blob: Blob): Promise<number | null> {
  // Decodificar em um contexto de 16 kHz já entrega o áudio na taxa que o modelo usa.
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
  const length = Math.min(decoded.length, ANALYSIS_LIMIT_S * SAMPLE_RATE);
  const mono = new Float32Array(length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] = (mono[i] as number) + (data[i] as number) / decoded.numberOfChannels;
  }

  const { NonRealTimeVAD } = await import('@ricky0123/vad-web');
  const vad = await NonRealTimeVAD.new({
    modelURL: `${VAD_ASSETS}silero_vad_legacy.onnx`,
    // Um trecho curto de instrumento parecido com voz não conta como a entrada do canto.
    minSpeechMs: 500,
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = VAD_ASSETS;
      ort.env.wasm.numThreads = 1;
    },
  });
  for await (const speech of vad.run(mono, SAMPLE_RATE)) return Math.round(speech.start);
  return null;
}

/**
 * Posição (ms, no arquivo) em que a voz entra pela primeira vez na faixa, ou
 * `null` se nenhuma voz foi encontrada. O resultado fica guardado por arquivo;
 * o modelo e o runtime só são baixados quando há uma faixa nova para analisar.
 * Rejeita se a análise não puder rodar (sem rede para baixar o modelo, por exemplo).
 */
export function firstVoiceMs(blob: Blob, sha256: string): Promise<number | null> {
  const known = remembered(sha256);
  if (known !== undefined) return Promise.resolve(known);
  let running = pending.get(sha256);
  if (!running) {
    running = analyze(blob).then(
      (value) => {
        remember(sha256, value);
        return value;
      },
      (error: unknown) => {
        pending.delete(sha256);
        throw error;
      },
    );
    pending.set(sha256, running);
  }
  return running;
}
