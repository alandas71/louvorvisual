import { SCHEMA_VERSION } from '@louvorvisual/domain';
import { z } from 'zod';

export const uuidSchema = z.uuid();
export const isoInstantSchema = z.iso.datetime();
export const civilDateSchema = z.iso.date();
export const revisionSchema = z.string().min(1);
export const orderSchema = z.int().min(0);
export const nonBlankSchema = z.string().refine((value) => value.trim().length > 0, 'blank');

/** Versão de esquema aceita por este cliente; documentos mais novos são recusados, não truncados. */
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);

export const aggregateMetaShape = {
  workspaceId: uuidSchema,
  schemaVersion: schemaVersionSchema,
  serverRevision: revisionSchema.nullable(),
  createdBy: uuidSchema,
  updatedBy: uuidSchema,
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  deletedAt: isoInstantSchema.nullable(),
};
