import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_FONTS, FONT_PACK_VERSION } from '@louvorvisual/domain';
import { describe, expect, it } from 'vitest';
import { fontFaceCss, fontPack } from './fontPack';

const packDir = join(__dirname, '..', '..', 'public', 'fonts', `v${fontPack.version}`);
const sha256 = (file: string) => createHash('sha256').update(readFileSync(join(packDir, file))).digest('hex');

describe('pacote de fontes embutido', () => {
  it('tem a versão e as oito famílias do catálogo, com 400 e 700', () => {
    expect(fontPack.version).toBe(FONT_PACK_VERSION);
    expect(fontPack.fonts.map((font) => [font.fontId, font.family])).toEqual(BUNDLED_FONTS.map((font) => [font.fontId, font.family]));
    for (const font of fontPack.fonts) expect(font.faces.map((face) => face.weight)).toEqual([400, 700]);
  });

  it('cada arquivo no disco tem o tamanho e o hash do manifesto', () => {
    for (const face of fontPack.fonts.flatMap((font) => font.faces)) {
      expect(readFileSync(join(packDir, face.file)).length, face.file).toBe(face.byteSize);
      expect(sha256(face.file), face.file).toBe(face.sha256);
    }
  });

  it('cada família tem a licença OFL com o hash do manifesto', () => {
    for (const font of fontPack.fonts) {
      expect(font.license).toBe('OFL-1.1');
      expect(sha256(font.licenseFile), font.licenseFile).toBe(font.licenseSha256);
      expect(readFileSync(join(packDir, font.licenseFile), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
  });

  it('não há arquivo de fonte fora do manifesto', () => {
    const listed = fontPack.fonts.flatMap((font) => font.faces.map((face) => face.file)).sort();
    expect(readdirSync(packDir).filter((name) => name.endsWith('.woff2')).sort()).toEqual(listed);
  });

  it('o CSS declara as dezesseis faces e só aponta para arquivos locais', () => {
    const css = fontFaceCss();
    expect(css.match(/@font-face/g)).toHaveLength(16);
    expect(css).not.toMatch(/https?:|\/\/fonts\./);
    for (const url of css.match(/url\("[^"]+"\)/g) ?? []) expect(url).toMatch(/^url\("\/fonts\/v1\/[a-z0-9-]+\.woff2"\)$/);
  });
});
