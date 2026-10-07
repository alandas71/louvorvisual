import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle } from './check-static.mjs';
import { prepareFonts } from './prepare-fonts.mjs';

// Gera o bundle embarcado em dist/: fontes conferidas → exportação estática do
// Next → cópia para dist/ → manifesto com o hash de cada arquivo → conferência.
// É o que o Gradle chama antes de empacotar os assets do APK.
const here = dirname(fileURLToPath(import.meta.url));
const projector = resolve(here, '..');
const dist = resolve(projector, 'dist');
const out = resolve(projector, 'out');
const require = createRequire(import.meta.url);

const fonts = await prepareFonts();

const next = require.resolve('next/dist/bin/next');
const built = spawnSync(process.execPath, [next, 'build'], { cwd: projector, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
if (built.status !== 0) process.exit(built.status ?? 1);

await rm(dist, { force: true, recursive: true });
await cp(out, dist, { recursive: true });

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)])));
  return files.flat();
}

const pkg = JSON.parse(await readFile(resolve(projector, 'package.json'), 'utf8'));
const files = [];
for (const path of (await walk(dist)).sort()) {
  const bytes = await readFile(path);
  files.push({ path: relative(dist, path).split(sep).join('/'), bytes: (await stat(path)).size, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = {
  name: pkg.name,
  version: pkg.version,
  // Onde o host precisa servir estes arquivos, e por onde entrar.
  basePath: '/assets',
  entry: 'index.html',
  bridgeVersion: 1,
  fontPackVersion: fonts.version,
  totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  files,
};
await writeFile(resolve(dist, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const report = await checkBundle(dist);
console.log(`Bundle do projetor em ${dist}: ${files.length} arquivos, ${(manifest.totalBytes / 1024).toFixed(0)} KiB.`);
console.log(report.summary);
