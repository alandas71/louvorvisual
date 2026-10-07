import { z } from 'zod';
import { arrangementSchema } from './arrangement';
import { assetSchema } from './asset';
import { revisionSchema, schemaVersionSchema, uuidSchema } from './common';
import { setlistSchema } from './setlist';
import { songSchema } from './song';
import { themeSchema } from './theme';

export const entityTypeSchema = z.enum(['song', 'arrangement', 'theme', 'setlist', 'asset']);
export const syncActionSchema = z.enum(['create', 'update', 'delete', 'restore']);
export const cursorSchema = z.string().regex(/^(0|[1-9]\d*)$/, 'cursor decimal esperado');

const payloadSchemas = {
  song: songSchema,
  arrangement: arrangementSchema,
  theme: themeSchema,
  setlist: setlistSchema,
  asset: assetSchema,
} as const;

const payloadSchema = z.union(Object.values(payloadSchemas));

export const syncOperationSchema = z.strictObject({
  opId: uuidSchema,
  entityType: entityTypeSchema,
  entityId: uuidSchema,
  action: syncActionSchema,
  baseRevision: cursorSchema,
  schemaVersion: schemaVersionSchema,
  payload: payloadSchema,
}).superRefine((operation, ctx) => {
  if (operation.payload.id !== operation.entityId) {
    ctx.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'payload.id deve coincidir com entityId' });
  }
  if (!payloadSchemas[operation.entityType].safeParse(operation.payload).success) {
    ctx.addIssue({ code: 'custom', path: ['payload'], message: 'payload deve ser um documento do tipo entityType' });
  }
  if (operation.action === 'create' && operation.baseRevision !== '0') {
    ctx.addIssue({ code: 'custom', path: ['baseRevision'], message: 'criação usa revisão base zero' });
  }
});

export const syncPushRequestSchema = z.strictObject({
  deviceId: uuidSchema,
  clientSchemaVersion: schemaVersionSchema,
  operations: z.array(syncOperationSchema).min(1).max(20),
});

export const syncBootstrapRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(100),
});

export const syncBootstrapPageQuerySchema = z.strictObject({
  cursor: cursorSchema.default('0'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const acceptedSyncResultSchema = z.strictObject({
  opId: uuidSchema,
  status: z.literal('accepted'),
  entityId: uuidSchema,
  revision: revisionSchema,
  cursor: cursorSchema,
});

export const conflictSyncResultSchema = z.strictObject({
  opId: uuidSchema,
  status: z.literal('conflict'),
  entityId: uuidSchema,
  currentRevision: revisionSchema,
  document: payloadSchema,
});

export const rejectedSyncResultSchema = z.strictObject({
  opId: uuidSchema,
  status: z.literal('rejected'),
  code: z.string().min(1),
  details: z.unknown().optional(),
});

export const syncResultSchema = z.union([acceptedSyncResultSchema, conflictSyncResultSchema, rejectedSyncResultSchema]);
export const syncPushResponseSchema = z.strictObject({ results: z.array(syncResultSchema) });

export const syncPullQuerySchema = z.strictObject({
  cursor: cursorSchema.default('0'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const changeSchema = z.strictObject({
  cursor: cursorSchema,
  entityType: entityTypeSchema,
  entityId: uuidSchema,
  revision: revisionSchema,
  action: syncActionSchema,
  document: payloadSchema,
});

export const syncPullResponseSchema = z.strictObject({
  changes: z.array(changeSchema),
  nextCursor: cursorSchema,
  hasMore: z.boolean(),
});

export const bootstrapDocumentSchema = z.strictObject({
  entityType: entityTypeSchema,
  entityId: uuidSchema,
  revision: revisionSchema,
  document: payloadSchema,
});

export const syncBootstrapResponseSchema = z.strictObject({
  token: uuidSchema,
  accessRevision: revisionSchema,
  cutCursor: cursorSchema,
  documents: z.array(bootstrapDocumentSchema),
  nextCursor: cursorSchema,
  hasMore: z.boolean(),
});

export const apiSuccessSchema = <T extends z.ZodType>(data: T) => z.strictObject({ data, requestId: uuidSchema });
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  requestId: uuidSchema,
});

export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncResult = z.infer<typeof syncResultSchema>;
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;
export type SyncEntityType = z.infer<typeof entityTypeSchema>;
export type SyncBootstrapResponse = z.infer<typeof syncBootstrapResponseSchema>;
