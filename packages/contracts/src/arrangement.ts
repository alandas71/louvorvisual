import {
  arrangementIssues,
  AUDIO_KINDS,
  AUDIO_POLICIES,
  OCCURRENCE_DURATION_MS,
  OCCURRENCE_VISUAL_KINDS,
  PRESENTATION_MODES,
} from '@louvorvisual/domain';
import { z } from 'zod';
import { aggregateMetaShape, nonBlankSchema, orderSchema, revisionSchema, uuidSchema } from './common';
import { themeOverridesSchema, themeRefSchema, themeStyleShape } from './theme';

export const occurrenceDurationSchema = z
  .int()
  .min(OCCURRENCE_DURATION_MS.min)
  .max(OCCURRENCE_DURATION_MS.max)
  .nullable();

export const occurrenceVisualOverridesSchema = z
  .strictObject({
    palette: themeStyleShape.palette,
    fontSizePx: themeStyleShape.fontSizePx,
    fontWeight: themeStyleShape.fontWeight,
    textAlign: themeStyleShape.textAlign,
    verticalAlign: themeStyleShape.verticalAlign,
  })
  .partial();

export const slideOccurrenceSchema = z.strictObject({
  id: uuidSchema,
  sourceSectionId: uuidSchema.nullable(),
  label: z.string(),
  text: z.string(),
  order: orderSchema,
  durationMs: occurrenceDurationSchema,
  visualKind: z.enum(OCCURRENCE_VISUAL_KINDS),
  visualOverrides: occurrenceVisualOverridesSchema.nullable(),
});

export const audioCueSchema = z.strictObject({
  occurrenceId: uuidSchema,
  startMs: z.int().min(0),
  endMs: z.int().min(0),
});

export const audioBindingSchema = z.strictObject({
  id: uuidSchema,
  assetId: uuidSchema,
  kind: z.enum(AUDIO_KINDS),
  policy: z.enum(AUDIO_POLICIES),
  volume: z.number().min(0).max(1),
  offsetMs: z.int(),
  cuesVersion: z.int().min(0),
  cues: z.array(audioCueSchema),
});

export const arrangementSchema = z
  .strictObject({
    ...aggregateMetaShape,
    id: uuidSchema,
    songId: uuidSchema,
    name: nonBlankSchema,
    basedOnSongRevision: revisionSchema.nullable(),
    themeRef: themeRefSchema,
    themeOverrides: themeOverridesSchema.nullable(),
    fontId: z.string().min(1).nullable(),
    fontPackVersion: z.string().min(1),
    occurrences: z.array(slideOccurrenceSchema),
    audioBindings: z.array(audioBindingSchema),
    selectedAudioBindingId: uuidSchema.nullable(),
    defaultMode: z.enum(PRESENTATION_MODES),
    // Opcional: documentos anteriores ao temporizador da introdução continuam válidos como estão.
    introDurationMs: occurrenceDurationSchema.optional(),
  })
  .check((ctx) => {
    for (const issue of arrangementIssues(ctx.value)) {
      ctx.issues.push({ code: 'custom', message: issue.code, path: issue.path, input: ctx.value });
    }
  });

export type ArrangementDocument = z.infer<typeof arrangementSchema>;
