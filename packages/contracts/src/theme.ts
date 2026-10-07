import {
  ASPECT_RATIOS,
  FONT_SIZE_PX,
  FONT_WEIGHTS,
  isHexColor,
  LINE_HEIGHT,
  MARGIN_PERCENT,
  OUTLINE_WIDTH_PX,
  paletteIssues,
  SHADOWS,
  TEXT_ALIGNS,
  TRANSITION_DURATION_MS,
  TRANSITION_KINDS,
  VERTICAL_ALIGNS,
} from '@louvorvisual/domain';
import { z } from 'zod';
import { aggregateMetaShape, nonBlankSchema, uuidSchema } from './common';

export const themeRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin'), presetId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('workspace'), themeId: uuidSchema }),
]);

const hexColorSchema = z.string().refine(isHexColor, 'invalid-color');

/** Fundo escuro e contraste são validados no par, nunca em uma cor isolada. */
export const themePaletteSchema = z
  .strictObject({ backgroundColor: z.string(), textColor: z.string() })
  .check((ctx) => {
    for (const issue of paletteIssues(ctx.value)) {
      ctx.issues.push({ code: 'custom', message: issue, input: ctx.value });
    }
  });

const marginPercentSchema = z.number().min(MARGIN_PERCENT.min).max(MARGIN_PERCENT.max);

export const themeStyleShape = {
  aspectRatio: z.enum(ASPECT_RATIOS),
  palette: themePaletteSchema,
  fontSizePx: z.int().min(FONT_SIZE_PX.min).max(FONT_SIZE_PX.max),
  fontWeight: z.union([z.literal(FONT_WEIGHTS[0]), z.literal(FONT_WEIGHTS[1])]),
  textAlign: z.enum(TEXT_ALIGNS),
  verticalAlign: z.enum(VERTICAL_ALIGNS),
  lineHeight: z.number().min(LINE_HEIGHT.min).max(LINE_HEIGHT.max),
  margins: z.strictObject({ horizontalPercent: marginPercentSchema, verticalPercent: marginPercentSchema }),
  shadow: z.enum(SHADOWS),
  outline: z
    .strictObject({
      color: hexColorSchema,
      widthPx: z.number().min(OUTLINE_WIDTH_PX.min).max(OUTLINE_WIDTH_PX.max),
    })
    .nullable(),
  transition: z.strictObject({
    kind: z.enum(TRANSITION_KINDS),
    durationMs: z.int().min(TRANSITION_DURATION_MS.min).max(TRANSITION_DURATION_MS.max),
  }),
  credits: z.strictObject({ showTitle: z.boolean(), showArtist: z.boolean() }),
};

export const themeOverridesSchema = z.strictObject(themeStyleShape).partial();

export const themeSchema = z.strictObject({
  ...aggregateMetaShape,
  ...themeStyleShape,
  id: uuidSchema,
  name: nonBlankSchema,
  basePresetId: z.string().min(1).nullable(),
  fontId: z.string().min(1),
  fontPackVersion: z.string().min(1),
});

export type ThemeDocument = z.infer<typeof themeSchema>;
