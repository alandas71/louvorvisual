import { BRIDGE_BASE_PATH, fontPackManifestSchema } from '@louvorvisual/contracts';
import type { FontPackManifest } from '@louvorvisual/domain';
import manifestJson from '../public/fonts/v1/manifest.json';

/** O mesmo pacote validado da PWA, copiado para o bundle por scripts/prepare-fonts.mjs; inválido quebra o build. */
export const fontPack: FontPackManifest = fontPackManifestSchema.parse(manifestJson);

export const FONT_PACK_BASE_URL = `${BRIDGE_BASE_PATH}/fonts/v${fontPack.version}`;

/** Regras @font-face das oito famílias e dois pesos, apontando só para arquivos do próprio bundle. */
export function fontFaceCss(manifest: FontPackManifest = fontPack): string {
  return manifest.fonts
    .flatMap((font) =>
      font.faces.map(
        (face) =>
          `@font-face{font-family:"${font.family}";font-style:${face.style};font-weight:${face.weight};` +
          // block: na projeção, texto invisível por um instante é melhor do que a
          // letra aparecer em outra fonte e depois mudar de quebra.
          `font-display:block;src:url("${FONT_PACK_BASE_URL}/${face.file}") format("woff2");unicode-range:${font.unicodeRange}}`,
      ),
    )
    .join('\n');
}
