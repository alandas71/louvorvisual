// Copia para public/vad/ o modelo de detecção de voz e o runtime WebAssembly
// que o analisa. Ficam fora do precache do service worker (são ~16 MB): o
// navegador só os baixa quando uma faixa é analisada pela primeira vez.
// O caminho inclui uma versão; ao atualizar as bibliotecas, mude VAD_ASSETS_VERSION
// aqui e em src/features/audio/firstVoice.ts.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VAD_ASSETS_VERSION = 'v1';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vadDist = dirname(require.resolve('@ricky0123/vad-web'));
const ortDist = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));

const root = join(webRoot, 'public', 'vad');
const target = join(root, VAD_ASSETS_VERSION);
rmSync(root, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const [dir, file] of [
  [vadDist, 'silero_vad_legacy.onnx'],
  [ortDist, 'ort-wasm-simd-threaded.mjs'],
  [ortDist, 'ort-wasm-simd-threaded.wasm'],
]) {
  copyFileSync(join(dir, file), join(target, file));
}
