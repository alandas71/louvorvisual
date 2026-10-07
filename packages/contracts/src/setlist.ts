import { duplicatedSetlistItems } from '@louvorvisual/domain';
import { z } from 'zod';
import { aggregateMetaShape, civilDateSchema, nonBlankSchema, orderSchema, uuidSchema } from './common';
import { themeRefSchema } from './theme';

export const setlistItemSchema = z.strictObject({
  id: uuidSchema,
  arrangementId: uuidSchema,
  order: orderSchema,
  notes: z.string(),
});

export const setlistSchema = z
  .strictObject({
    ...aggregateMetaShape,
    id: uuidSchema,
    title: nonBlankSchema,
    serviceDate: civilDateSchema.nullable(),
    timeZone: z.string().min(1),
    themeRef: themeRefSchema.nullable(),
    notes: z.string(),
    items: z.array(setlistItemSchema),
  })
  .check((ctx) => {
    for (const { index, field } of duplicatedSetlistItems(ctx.value.items)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate-item-${field}`,
        path: ['items', index, field],
        input: ctx.value,
      });
    }
  });

export type SetlistDocument = z.infer<typeof setlistSchema>;
