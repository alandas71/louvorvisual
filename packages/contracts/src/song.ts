import { SECTION_DETECTIONS, SECTION_KINDS } from '@louvorvisual/domain';
import { z } from 'zod';
import { aggregateMetaShape, nonBlankSchema, orderSchema, uuidSchema } from './common';

export const songSectionSchema = z.strictObject({
  id: uuidSchema,
  kind: z.enum(SECTION_KINDS),
  label: z.string(),
  text: z.string(),
  order: orderSchema,
  detection: z.enum(SECTION_DETECTIONS),
});

export const songSchema = z.strictObject({
  ...aggregateMetaShape,
  id: uuidSchema,
  title: nonBlankSchema,
  artist: z.string().nullable(),
  authors: z.array(z.string()),
  musicalKey: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string(),
  rawLyrics: z.string(),
  sections: z.array(songSectionSchema),
});

export type SongDocument = z.infer<typeof songSchema>;
