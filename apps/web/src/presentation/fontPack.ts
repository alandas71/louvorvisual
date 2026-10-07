import { fontPackManifestSchema } from '@louvorvisual/contracts';
import type { FontPackManifest } from '@louvorvisual/domain';
import manifestJson from '../../public/fonts/v1/manifest.json';

/** Manifesto gerado por scripts/build-font-pack.mjs; inválido quebra o build. */
export const fontPack: FontPackManifest = fontPackManifestSchema.parse(manifestJson);

export const FONT_PACK_BASE_URL = `/fonts/v${fontPack.version}`;

export function fontFileUrl(file: string): string {
  return `${FONT_PACK_BASE_URL}/${file}`;
}

/** Regras @font-face de todas as famílias e pesos, apontando só para arquivos locais. */
export function fontFaceCss(manifest: FontPackManifest = fontPack): string {
  return manifest.fonts
    .flatMap((font) =>
      font.faces.map(
        (face) =>
          `@font-face{font-family:"${font.family}";font-style:${face.style};font-weight:${face.weight};` +
          // block: na projeção, texto invisível por um instante é melhor do que
          // a letra aparecer em outra fonte e depois mudar de quebra.
          `font-display:block;src:url("${fontFileUrl(face.file)}") format("woff2");unicode-range:${font.unicodeRange}}`,
      ),
    )
    .join('\n');
}

export { fontStack } from '@louvorvisual/presentation';
