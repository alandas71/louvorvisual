import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Confere que o bundle em dist/ é autossuficiente: todo arquivo citado existe
// dentro dele, sob o prefixo que o host serve, e nada é carregado de fora.
// A prova em execução (nenhum pedido a outra origem) está nos testes e2e.

const BASE = '/assets/';

/**
 * Endereços que aparecem como texto no JavaScript e não são carregados.
 * Conferidos um a um no bundle gerado; qualquer outro endereço absoluto
 * reprova a conferência.
 */
const INERT_HOSTS = new Set([
  // Links em mensagens de erro do React e do Next.
  'react.dev',
  'nextjs.org',
  // Namespaces XML (SVG, MathML).
  'www.w3.org',
  // Texto de licença dos polyfills que o Next embute.
  'github.com',
  // Bases fictícias usadas para testar e montar `URL` ("https://a", "https://x", "http://n").
  'a',
  'x',
  'n',
  // Identificadores de esquema que o zod sabe escrever; nunca são buscados.
  'json-schema.org',
]);

/** Sinais de recursos que não podem existir no bundle embarcado. */
const FORBIDDEN = [
  ['fonts.googleapis.com', 'fonte remota'],
  ['fonts.gstatic.com', 'fonte remota'],
  ['serviceWorker.register', 'service worker'],
  ['/_next/image', 'otimização de imagem do servidor'],
  ['/api/v1', 'chamada direta à API (a rede é do host)'],
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)])));
  return files.flat();
}

export async function checkBundle(dist) {
  const problems = [];
  const paths = (await walk(dist)).map((path) => relative(dist, path).split(sep).join('/'));
  const has = new Set(paths);
  const read = (path) => readFile(resolve(dist, path), 'utf8');
  const local = (url, from) => {
    const clean = url.split(/[?#]/)[0];
    if (clean.startsWith('data:')) return;
    if (!clean.startsWith(BASE)) return problems.push(`${from}: referência fora do bundle: ${url}`);
    if (!has.has(decodeURIComponent(clean.slice(BASE.length)))) problems.push(`${from}: arquivo citado não existe no bundle: ${url}`);
  };

  if (!has.has('index.html')) problems.push('index.html ausente');

  // HTML: scripts, estilos, pré-carregamentos e ícones saem todos de /assets/.
  const html = paths.filter((path) => path.endsWith('.html'));
  for (const path of html) {
    const text = await read(path);
    for (const match of text.matchAll(/<(?:script|link|img|source|audio|video|iframe)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) local(match[1], path);
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) local(match[1].replace(/\\u0026/g, '&'), path);
    if (/<base\b/i.test(text)) problems.push(`${path}: <base> não é permitido`);
    if (/http-equiv=["']refresh/i.test(text)) problems.push(`${path}: redirecionamento não é permitido`);
  }

  // CSS: fontes e imagens só do bundle; nenhum @import.
  for (const path of paths.filter((item) => item.endsWith('.css'))) {
    const text = await read(path);
    if (/@import/i.test(text)) problems.push(`${path}: @import não é permitido`);
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) local(match[1], path);
  }

  // JavaScript: nenhum endereço de outra origem, nenhum recurso de servidor.
  const hosts = new Map();
  const scripts = paths.filter((item) => item.endsWith('.js'));
  const mockChunks = [];
  for (const path of scripts) {
    const text = await read(path);
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.set(match[1], path);
    for (const [needle, what] of FORBIDDEN) if (text.includes(needle)) problems.push(`${path}: ${what} (${needle})`);
    if (text.includes('lv-mock-host')) mockChunks.push(path);
  }
  for (const [host, path] of hosts) {
    // A origem virtual do WebView é a única "externa" que o bundle conhece, e é ele mesmo.
    if (host === 'appassets.androidplatform.net' || INERT_HOSTS.has(host)) continue;
    problems.push(`${path}: endereço de outra origem no JavaScript: ${host}`);
  }

  // O host simulado só pode existir em um pedaço carregado sob demanda.
  const index = has.has('index.html') ? await read('index.html') : '';
  for (const chunk of mockChunks) if (index.includes(chunk.split('/').at(-1))) problems.push(`index.html carrega o host simulado (${chunk})`);
  if (mockChunks.length === 0) problems.push('host simulado não encontrado em nenhum pedaço (esperado em um pedaço sob demanda)');

  // Fontes: os 16 arquivos do manifesto, com os bytes do pacote validado, e as licenças.
  let fontFiles = 0;
  const fontManifests = paths.filter((path) => /^fonts\/v[^/]+\/manifest\.json$/.test(path));
  if (fontManifests.length !== 1) problems.push(`esperado um pacote de fontes; encontrados ${fontManifests.length}`);
  for (const manifestPath of fontManifests) {
    const folder = dirname(manifestPath);
    const manifest = JSON.parse(await read(manifestPath));
    if (manifest.fonts.length !== 8) problems.push(`esperadas 8 famílias de fontes; encontradas ${manifest.fonts.length}`);
    for (const font of manifest.fonts) {
      for (const face of font.faces) {
        const path = `${folder}/${face.file}`;
        if (!has.has(path)) {
          problems.push(`fonte ausente: ${path}`);
          continue;
        }
        const bytes = await readFile(resolve(dist, path));
        if (createHash('sha256').update(bytes).digest('hex') !== face.sha256) problems.push(`fonte diferente do pacote validado: ${path}`);
        if (!index.includes(`${BASE}${path}`)) problems.push(`index.html não declara a fonte ${path}`);
        fontFiles += 1;
      }
      if (!has.has(`${folder}/${font.licenseFile}`)) problems.push(`licença ausente: ${font.licenseFile}`);
    }
  }
  if (fontFiles !== 16) problems.push(`esperados 16 arquivos de fonte; conferidos ${fontFiles}`);

  // O manifesto do bundle descreve exatamente os arquivos presentes.
  if (has.has('bundle-manifest.json')) {
    const manifest = JSON.parse(await read('bundle-manifest.json'));
    const listed = new Map(manifest.files.map((file) => [file.path, file]));
    for (const path of paths) {
      if (path === 'bundle-manifest.json') continue;
      const entry = listed.get(path);
      if (!entry) problems.push(`arquivo fora do manifesto do bundle: ${path}`);
      else if (entry.bytes !== (await stat(resolve(dist, path))).size) problems.push(`tamanho diferente do manifesto do bundle: ${path}`);
    }
    for (const path of listed.keys()) if (!has.has(path)) problems.push(`manifesto do bundle cita arquivo ausente: ${path}`);
  } else {
    problems.push('bundle-manifest.json ausente');
  }

  if (problems.length > 0) throw new Error(`Bundle do projetor reprovado:\n- ${problems.join('\n- ')}`);
  return {
    files: paths.length,
    scripts: scripts.length,
    stylesheets: paths.filter((item) => item.endsWith('.css')).length,
    fontFiles,
    mockChunks,
    inertHosts: [...hosts.keys()].sort(),
    summary: `Bundle íntegro: ${paths.length} arquivos, ${scripts.length} scripts, ${fontFiles} fontes locais conferidas; nenhuma referência fora de ${BASE}.`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkBundle(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'));
  console.log(report.summary);
  console.log(`Endereços inertes no JavaScript (texto de mensagens, não carregados): ${report.inertHosts.join(', ') || 'nenhum'}`);
  console.log(`Host simulado, só sob demanda: ${report.mockChunks.join(', ')}`);
}
