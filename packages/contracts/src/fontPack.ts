import { BUNDLED_FONT_IDS, FONT_WEIGHTS, type FontPackManifest } from '@louvorvisual/domain';
import { z } from 'zod';
import { sha256Schema } from './asset';

// Caminho dentro da pasta do pacote: sem barra inicial, sem `..`.
const relativeFileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*([./][A-Za-z0-9_-]+)*$/, 'caminho relativo esperado');

export const fontFaceFileSchema = z.strictObject({
  weight: z.union([z.literal(FONT_WEIGHTS[0]), z.literal(FONT_WEIGHTS[1])]),
  style: z.literal('normal'),
  file: relativeFileSchema,
  sha256: sha256Schema,
  byteSize: z.int().min(1),
});

export const fontPackEntrySchema = z.strictObject({
  fontId: z.enum(BUNDLED_FONT_IDS),
  family: z.string().min(1),
  license: z.string().min(1),
  licenseFile: relativeFileSchema,
  licenseSha256: sha256Schema,
  reservedFontName: z.string().min(1).nullable(),
  source: z.strictObject({
    package: z.string().min(1),
    packageVersion: z.string().min(1),
    upstreamVersion: z.string().min(1),
    metadataUrl: z.url(),
  }),
  subsets: z.array(z.string().min(1)).min(1),
  unicodeRange: z.string().min(1),
  faces: z.array(fontFaceFileSchema),
});

/** Pacote completo: as oito famílias, cada uma com os dois pesos, sem repetição. */
export const fontPackManifestSchema: z.ZodType<FontPackManifest> = z
  .strictObject({ version: z.string().min(1), fonts: z.array(fontPackEntrySchema) })
  .check((ctx) => {
    const ids = ctx.value.fonts.map((font) => font.fontId);
    for (const fontId of BUNDLED_FONT_IDS) {
      if (ids.filter((id) => id === fontId).length !== 1) {
        ctx.issues.push({ code: 'custom', message: `font-pack-family:${fontId}`, path: ['fonts'], input: ctx.value });
      }
    }
    ctx.value.fonts.forEach((font, index) => {
      const weights = font.faces.map((face) => face.weight).sort();
      if (weights.join() !== [...FONT_WEIGHTS].join()) {
        ctx.issues.push({ code: 'custom', message: 'font-pack-weights', path: ['fonts', index, 'faces'], input: ctx.value });
      }
    });
  });
