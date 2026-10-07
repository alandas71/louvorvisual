import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, type FontPackManifest } from '@louvorvisual/domain';
import { fontPackManifestSchema } from './fontPack';

const manifest: FontPackManifest = {
  version: '1',
  fonts: BUNDLED_FONTS.map(({ fontId, family }) => ({
    fontId,
    family,
    license: 'OFL-1.1',
    licenseFile: `licenses/${fontId}-OFL.txt`,
    licenseSha256: 'b'.repeat(64),
    reservedFontName: null,
    source: { package: `@fontsource/${fontId}`, packageVersion: '5.3.0', upstreamVersion: 'v1', metadataUrl: 'https://example.org/METADATA.pb' },
    subsets: ['latin'],
    unicodeRange: 'U+0000-00FF',
    faces: [400, 700].map((weight) => ({ weight: weight as 400 | 700, style: 'normal', file: `${fontId}-${weight}.woff2`, sha256: 'a'.repeat(64), byteSize: 1000 })),
  })),
};

describe('fontPackManifestSchema', () => {
  it('aceita o pacote completo', () => {
    expect(fontPackManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('recusa pacote sem uma das oito famílias ou com família repetida', () => {
    expect(fontPackManifestSchema.safeParse({ ...manifest, fonts: manifest.fonts.slice(1) }).success).toBe(false);
    expect(fontPackManifestSchema.safeParse({ ...manifest, fonts: [...manifest.fonts, manifest.fonts[0]] }).success).toBe(false);
  });

  it('recusa família sem os pesos 400 e 700', () => {
    const [first, ...rest] = manifest.fonts;
    const fonts = [{ ...first, faces: first!.faces.slice(0, 1) }, ...rest];
    expect(fontPackManifestSchema.safeParse({ ...manifest, fonts }).success).toBe(false);
  });

  it.each(['/fonts/a.woff2', '../a.woff2', 'a/../../b.woff2', 'https://exemplo.org/a.woff2', ''])('recusa caminho %j', (file) => {
    const [first, ...rest] = manifest.fonts;
    const fonts = [{ ...first, faces: [{ ...first!.faces[0], file }, first!.faces[1]] }, ...rest];
    expect(fontPackManifestSchema.safeParse({ ...manifest, fonts }).success).toBe(false);
  });
});
