import { ASSET_REMOTE_STATES, AUDIO_KINDS, AUDIO_MIME_TYPES, MAX_ASSET_BYTES } from '@louvorvisual/domain';
import { z } from 'zod';
import { isoInstantSchema, nonBlankSchema, uuidSchema } from './common';

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'invalid-sha256');

export const assetSchema = z.strictObject({
  id: uuidSchema,
  workspaceId: uuidSchema,
  sha256: sha256Schema,
  filename: nonBlankSchema,
  mimeType: z.enum(AUDIO_MIME_TYPES),
  byteSize: z.int().min(1).max(MAX_ASSET_BYTES),
  audioKind: z.enum(AUDIO_KINDS),
  durationMs: z.int().min(0).nullable(),
  remoteState: z.enum(ASSET_REMOTE_STATES),
  storageKey: z.string().min(1).nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  deletedAt: isoInstantSchema.nullable(),
});

export type AssetDocument = z.infer<typeof assetSchema>;
