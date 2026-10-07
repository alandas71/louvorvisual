import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copia o pacote de fontes validado (o mesmo da PWA) para public/, de onde a
// exportação estática o leva para o bundle. Cada arquivo é conferido contra o
// hash do manifesto: fonte diferente do pacote não é embarcada.
const here = dirname(fileURLToPath(import.meta.url));
const projector = resolve(here, '..');
const source = resolve(projector, '../web/public/fonts');

export async function prepareFonts() {
  const manifest = JSON.parse(await readFile(resolve(source, 'v1/manifest.json'), 'utf8'));
  const base = resolve(source, `v${manifest.version}`);
  const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  let files = 0;
  for (const font of manifest.fonts) {
    for (const face of font.faces) {
      if ((await sha(resolve(base, face.file))) !== face.sha256) throw new Error(`Fonte diferente do manifesto: ${face.file}`);
      files += 1;
    }
    if ((await sha(resolve(base, font.licenseFile))) !== font.licenseSha256) throw new Error(`Licença diferente do manifesto: ${font.licenseFile}`);
  }
  const target = resolve(projector, 'public/fonts');
  await rm(target, { force: true, recursive: true });
  await mkdir(target, { recursive: true });
  await cp(base, resolve(target, `v${manifest.version}`), { recursive: true });
  return { version: manifest.version, families: manifest.fonts.length, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareFonts();
  console.log(`Pacote de fontes v${result.version}: ${result.families} famílias, ${result.files} arquivos conferidos.`);
}
