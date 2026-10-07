// Monta o pacote de fontes embutido em public/fonts/v<versão>/ a partir dos
// pacotes @fontsource fixados no package.json, valida cada arquivo e escreve o
// manifesto com hashes. Executar com `npm run fonts:build` ao trocar versões.
// Os textos de licença em licenses/ vêm de google/fonts (ofl/<família>/OFL.txt)
// e são mantidos no repositório; este script apenas os confere.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

const PACK_VERSION = '1';
const WEIGHTS = [400, 700];
const PORTUGUESE = 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ';
const FONTS = [
  { fontId: 'inter', family: 'Inter', googleDir: 'inter', reservedFontName: null },
  { fontId: 'roboto', family: 'Roboto', googleDir: 'roboto', reservedFontName: null },
  { fontId: 'open-sans', family: 'Open Sans', googleDir: 'opensans', reservedFontName: null },
  { fontId: 'montserrat', family: 'Montserrat', googleDir: 'montserrat', reservedFontName: null },
  { fontId: 'lato', family: 'Lato', googleDir: 'lato', reservedFontName: 'Lato' },
  { fontId: 'noto-sans', family: 'Noto Sans', googleDir: 'notosans', reservedFontName: null },
  { fontId: 'source-sans-3', family: 'Source Sans 3', googleDir: 'sourcesans3', reservedFontName: 'Source' },
  { fontId: 'atkinson-hyperlegible', family: 'Atkinson Hyperlegible', googleDir: 'atkinsonhyperlegible', reservedFontName: null },
];

const require = createRequire(import.meta.url);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(webRoot, 'public', 'fonts', `v${PACK_VERSION}`);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function fail(message) {
  console.error(`Pacote de fontes inválido: ${message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name.endsWith('.woff2') || name === 'manifest.json') rmSync(join(outDir, name));
}

const fonts = FONTS.map(({ fontId, family, googleDir, reservedFontName }) => {
  const packageName = `@fontsource/${fontId}`;
  const packageDir = dirname(require.resolve(`${packageName}/package.json`));
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(join(packageDir, 'metadata.json'), 'utf8'));
  const unicode = JSON.parse(readFileSync(join(packageDir, 'unicode.json'), 'utf8'));
  if (metadata.family !== family) fail(`${fontId}: família ${metadata.family}`);
  if (packageJson.license !== 'OFL-1.1') fail(`${fontId}: licença ${packageJson.license}`);

  const licenseFile = `licenses/${fontId}-OFL.txt`;
  if (!existsSync(join(outDir, licenseFile))) fail(`${fontId}: falta ${licenseFile}`);
  const license = readFileSync(join(outDir, licenseFile));
  if (!license.includes('SIL OPEN FONT LICENSE Version 1.1')) fail(`${fontId}: ${licenseFile} não é a OFL 1.1`);
  const declaresReservedName = license.includes('Reserved Font Name "') || license.includes("Reserved Font Name '");
  if (declaresReservedName !== (reservedFontName !== null)) fail(`${fontId}: nome reservado divergente da licença`);

  const faces = WEIGHTS.map((weight) => {
    const source = join(packageDir, 'files', `${fontId}-latin-${weight}-normal.woff2`);
    const bytes = readFileSync(source);
    const font = fontkit.create(bytes);
    // Instâncias estáticas de fontes variáveis mantêm o nome do mestre padrão
    // (ex.: "Montserrat Thin"); o peso real está em OS/2.
    if (!font.familyName.startsWith(family)) fail(`${fontId} ${weight}: nome interno ${font.familyName}`);
    if (font['OS/2'].usWeightClass !== weight) fail(`${fontId} ${weight}: peso real ${font['OS/2'].usWeightClass}`);
    const missing = [...PORTUGUESE].filter((char) => !font.hasGlyphForCodePoint(char.codePointAt(0)));
    if (missing.length > 0) fail(`${fontId} ${weight}: sem glifo para ${missing.join(' ')}`);
    const file = `${fontId}-${weight}.woff2`;
    copyFileSync(source, join(outDir, file));
    return { weight, style: 'normal', file, sha256: sha256(bytes), byteSize: bytes.length };
  });

  return {
    fontId,
    family,
    license: 'OFL-1.1',
    licenseFile,
    licenseSha256: sha256(license),
    reservedFontName,
    source: {
      package: packageName,
      packageVersion: packageJson.version,
      upstreamVersion: `Google Fonts ${metadata.version} (${metadata.lastModified})`,
      metadataUrl: `https://raw.githubusercontent.com/google/fonts/main/ofl/${googleDir}/METADATA.pb`,
    },
    subsets: ['latin'],
    unicodeRange: unicode.latin,
    faces,
  };
});

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ version: PACK_VERSION, fonts }, null, 2)}\n`);
const total = fonts.flatMap((font) => font.faces).reduce((sum, face) => sum + face.byteSize, 0);
console.log(`Pacote v${PACK_VERSION}: ${fonts.length} famílias, ${fonts.length * WEIGHTS.length} arquivos, ${total} bytes.`);
