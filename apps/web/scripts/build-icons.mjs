// Gera os ícones do aplicativo a partir da marca oficial. Executar
// `npm run icons:build` ao trocar public/brand/louvorvisual.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = join(webRoot, 'public', 'brand');
const source = join(brandDir, 'louvorvisual.png');
const out = (name) => join(webRoot, 'public', 'icons', name);
mkdirSync(brandDir, { recursive: true });

// O arquivo completo inclui o nome da marca. Para favicon, menus e atalhos,
// recortamos o símbolo para que ele permaneça legível em 16px.
const mark = await sharp(source)
  .extract({ left: 174, top: 104, width: 906, height: 680 })
  .resize(512, 512, { fit: 'contain', background: '#080b10' })
  .png()
  .toBuffer();
await sharp(mark).toFile(join(brandDir, 'louvorvisual-mark.png'));

await sharp(mark).resize(192, 192).png().toFile(out('icon-192.png'));
await sharp(mark).resize(512, 512).png().toFile(out('icon-512.png'));
// Maskable: o desenho ocupa a zona segura central, sobre fundo sem cantos.
const inner = await sharp(mark).resize(360, 360).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0a0c11' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile(out('icon-maskable-512.png'));
// iOS não usa o manifesto: o ícone da tela de início vem deste arquivo, sem transparência.
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#0a0c11' } })
  .composite([{ input: await sharp(mark).resize(180, 180).png().toBuffer(), gravity: 'center' }])
  .png()
  .toFile(out('apple-touch-icon.png'));

// Um ICO pode reunir diversos tamanhos PNG em um único arquivo, atendendo
// navegadores e atalhos que ainda procuram especificamente por favicon.ico.
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(mark).resize(size, size).png().toBuffer()));
const directorySize = 6 + images.length * 16;
let offset = directorySize;
const entries = images.map((image, index) => {
  const entry = Buffer.alloc(16);
  entry[0] = sizes[index] === 256 ? 0 : sizes[index];
  entry[1] = sizes[index] === 256 ? 0 : sizes[index];
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.length;
  return entry;
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
writeFileSync(join(webRoot, 'src', 'app', 'favicon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('Ícones e favicon gerados a partir da marca em public/brand.');
