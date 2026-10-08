// Copia para public/asr/ o runtime WebAssembly que roda o reconhecimento de
// fala (Whisper) da detecção da primeira voz. Fica fora do precache do service
// worker (~27 MB): o navegador só o baixa quando uma faixa é analisada pela
// primeira vez. O caminho inclui uma versão; ao atualizar @huggingface/transformers,
// mude ASR_ASSETS_VERSION aqui e em src/features/audio/firstVoice.worker.ts.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASR_ASSETS_VERSION = 'v1';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// O runtime precisa ser exatamente o da versão que a biblioteca usa.
const transformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
const ortDist = dirname(transformers.resolve('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm'));

const root = join(webRoot, 'public', 'asr');
const target = join(root, ASR_ASSETS_VERSION);
rmSync(root, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  copyFileSync(join(ortDist, file), join(target, file));
}
