import { createHash } from 'node:crypto';
import type { SyncBootstrapResponse, SyncOperation, SyncPullResponse, SyncResult } from '@louvorvisual/contracts';

export type SyncDocument = SyncOperation['payload'];

export type SyncStore = {
  ensureWorkspace?(workspace: { id: string; name: string; timezone: string }): Promise<void>;
  apply(workspaceId: string, actorId: string, operation: SyncOperation, deviceId?: string): Promise<SyncResult>;
  pull(workspaceId: string, cursor: string, limit: number): Promise<SyncPullResponse>;
  bootstrap?(workspaceId: string, limit: number): Promise<SyncBootstrapResponse>;
  bootstrapPage?(workspaceId: string, token: string, cursor: string, limit: number): Promise<SyncBootstrapResponse>;
  get?(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string): Promise<{ revision: string; document: SyncDocument } | null>;
  list?(workspaceId: string, entityType: SyncOperation['entityType'], limit: number): Promise<{ revision: string; document: SyncDocument }[]>;
  revisions?(workspaceId: string, entityType: SyncOperation['entityType'], entityId: string, limit: number): Promise<{ revision: string; action: SyncOperation['action']; document: SyncDocument }[]>;
};

export function operationHash(operation: SyncOperation): string {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}

type Stamp = { actorId: string; revision: bigint; now: Date; isNew: boolean };

/**
 * Documento aceito: revisão, autoria e instantes são atribuídos pelo servidor.
 * Arquivos não têm revisão nem autoria no documento, por isso os campos só são
 * preenchidos quando existem no payload.
 */
export function acceptedDocument(operation: SyncOperation, stamp: Stamp): SyncDocument {
  const payload = operation.payload as Record<string, unknown>;
  const now = stamp.now.toISOString();
  return {
    ...operation.payload,
    ...('serverRevision' in payload ? { serverRevision: stamp.revision.toString() } : {}),
    ...('createdBy' in payload && stamp.isNew ? { createdBy: stamp.actorId } : {}),
    ...('updatedBy' in payload ? { updatedBy: stamp.actorId } : {}),
    ...(stamp.isNew ? { createdAt: now } : {}),
    updatedAt: now,
    deletedAt: operation.action === 'delete' ? now : operation.action === 'restore' ? null : operation.payload.deletedAt,
  } as SyncDocument;
}
