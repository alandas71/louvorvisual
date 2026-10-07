/** UUID gerado no cliente para IDs de domínio. */
export type Uuid = string;

/** Instante em UTC, ISO 8601 (ex.: 2026-10-05T12:00:00.000Z). */
export type IsoInstant = string;

/** Data civil sem horário (YYYY-MM-DD); não é convertida para UTC. */
export type CivilDate = string;

/** Revisões e cursores trafegam como strings. */
export type Revision = string;

/** Versão de esquema dos documentos desta etapa. */
export const SCHEMA_VERSION = 1;

/**
 * Campos de revisão, autoria e exclusão comuns aos agregados compartilháveis.
 * `serverRevision` é `null` até a primeira confirmação do servidor;
 * `deletedAt` preenchido representa exclusão sincronizável (tombstone).
 */
export type AggregateMeta = {
  workspaceId: Uuid;
  schemaVersion: typeof SCHEMA_VERSION;
  serverRevision: Revision | null;
  createdBy: Uuid;
  updatedBy: Uuid;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  deletedAt: IsoInstant | null;
};
