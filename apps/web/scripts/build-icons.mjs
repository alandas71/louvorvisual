// Gera os ícones PNG do manifesto a partir de src/app/icon.svg. Usa o sharp
// que acompanha o Next; executar com `npm run icons:build` ao mudar o ícone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(webRoot, 'src', 'app', 'icon.svg'));
const out = (name) => join(webRoot, 'public', 'icons', name);

await sharp(svg, { density: 300 }).resize(192, 192).png().toFile(out('icon-192.png'));
await sharp(svg, { density: 300 }).resize(512, 512).png().toFile(out('icon-512.png'));
// Maskable: o desenho ocupa a zona segura central, sobre fundo sem cantos.
const inner = await sharp(svg, { density: 300 }).resize(360, 360).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#111827' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile(out('icon-maskable-512.png'));
console.log('Ícones gerados em public/icons.');
