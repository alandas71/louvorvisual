// Gera public/sw.js depois do `next build`: lista os documentos dos shells, os
// arquivos de .next/static e os recursos públicos, com o SHA-256 de cada um.
// A versão é o hash dessa lista, de modo que qualquer byte diferente produz
// outra versão e outro cache.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Rotas de documento que abrem sem servidor e o HTML pré-renderizado de cada uma. */
export const SHELLS = { '/': 'index.html', '/app': 'app.html', '/projecao': 'projecao.html' };
/** Rotas de metadados geradas pelo Next. */
const GENERATED = { '/manifest.webmanifest': 'manifest.webmanifest.body', '/icon.svg': 'icon.svg.body' };
/** Pastas de public/ que fazem parte do aplicativo offline. */
const PUBLIC_DIRS = ['fonts', 'icons'];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)],
  );
}

function toUrl(base, root, file) {
  return `${base}/${relative(root, file).split(sep).map(encodeURIComponent).join('/')}`;
}

/**
 * @param {{ salt?: string, tamper?: string }} [options] `salt` força outra
 * versão com os mesmos arquivos; `tamper` troca o hash esperado de uma URL.
 * As duas opções existem para os testes da política de atualização.
 */
export function buildServiceWorker(options = {}) {
  const nextDir = join(webRoot, '.next');
  const appDir = join(nextDir, 'server', 'app');
  const staticDir = join(nextDir, 'static');
  if (!existsSync(staticDir)) throw new Error('Execute `next build` antes de gerar o service worker.');

  const entries = [];
  for (const [url, file] of Object.entries({ ...SHELLS, ...GENERATED })) {
    entries.push({ url, sha256: sha256(readFileSync(join(appDir, file))) });
  }
  for (const file of walk(staticDir)) {
    // O runtime do reconhecimento de fala (~27 MB) não entra no aplicativo offline:
    // é servido de public/asr/ e baixado só quando uma faixa é analisada.
    if (file.endsWith('.wasm')) continue;
    entries.push({ url: toUrl('/_next/static', staticDir, file), sha256: sha256(readFileSync(file)) });
  }
  for (const dir of PUBLIC_DIRS) {
    const root = join(webRoot, 'public', dir);
    for (const file of walk(root)) entries.push({ url: toUrl(`/${dir}`, root, file), sha256: sha256(readFileSync(file)) });
  }
  entries.sort((a, b) => a.url.localeCompare(b.url));

  const version = sha256(JSON.stringify(entries) + (options.salt ?? '')).slice(0, 16);
  const published = entries.map((entry) => (entry.url === options.tamper ? { ...entry, sha256: '0'.repeat(64) } : entry));
  const build = { version, shells: Object.keys(SHELLS), entries: published };
  const template = readFileSync(join(webRoot, 'src', 'sw', 'sw.template.js'), 'utf8');
  return { version, entries, source: template.replace('__LV_BUILD__', () => JSON.stringify(build)) };
}

const SW_PATH = join(webRoot, 'public', 'sw.js');

// Uso: node scripts/generate-sw.mjs [--salt=<texto>] [--tamper=<url>]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const { version, entries, source } = buildServiceWorker({ salt: option('salt'), tamper: option('tamper') });
  writeFileSync(SW_PATH, source);
  console.log(`Service worker ${version}: ${entries.length} recursos em precache.`);
}
