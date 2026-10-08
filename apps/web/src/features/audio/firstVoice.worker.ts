/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import { findLyricsStart, lyricsLanguage, type TimedWord } from './lyricsStart';

/** Mesma versão de scripts/copy-asr-assets.mjs. */
const ASR_ASSETS = '/asr/v1/';
/** Whisper "base" com tempos por palavra: o menor que acerta canto com instrumentos. */
const MODEL = 'onnx-community/whisper-base_timestamped';
const SAMPLE_RATE = 16_000;
/** O modelo ouve 30 s por vez; as janelas se sobrepõem para um verso não ficar cortado na emenda. */
const WINDOW_S = 30;
const STEP_S = 25;

export type FirstVoiceRequest = { samples: Float32Array; lyrics: string };
export type FirstVoiceResponse = { ok: true; startMs: number | null } | { ok: false; message: string };

env.allowLocalModels = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = new URL(ASR_ASSETS, self.location.origin).href;

async function analyze({ samples, lyrics }: FirstVoiceRequest): Promise<number | null> {
  const transcribe = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' });
  const language = lyricsLanguage(lyrics);
  for (let from = 0; from + SAMPLE_RATE <= samples.length; from += STEP_S * SAMPLE_RATE) {
    const output = await transcribe(samples.subarray(from, from + WINDOW_S * SAMPLE_RATE), { return_timestamps: 'word', language, task: 'transcribe' });
    const chunks: { text: string; timestamp: [number | null, number | null] }[] = (Array.isArray(output) ? output[0]?.chunks : output.chunks) ?? [];
    const offsetMs = (from / SAMPLE_RATE) * 1000;
    const words: TimedWord[] = chunks.flatMap((chunk) => (typeof chunk.timestamp[0] === 'number' ? [{ text: chunk.text, startMs: offsetMs + chunk.timestamp[0] * 1000 }] : []));
    // Só interessa a primeira entrada da letra: achou, não precisa ouvir o resto.
    const startMs = findLyricsStart(words, lyrics);
    if (startMs !== null) return Math.round(startMs);
  }
  return null;
}

self.addEventListener('message', (event: MessageEvent<FirstVoiceRequest>) => {
  const reply = (response: FirstVoiceResponse) => self.postMessage(response);
  analyze(event.data).then(
    (startMs) => reply({ ok: true, startMs }),
    (error: unknown) => reply({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
});
