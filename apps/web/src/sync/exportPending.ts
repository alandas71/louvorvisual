import { listOpenConflicts, type SyncStorage } from '@louvorvisual/sync';
import type { LocalSession } from '@/local/session';

/**
 * Pendências do perfil em um arquivo legível: documentos ainda não
 * confirmados, tentativas e conflitos abertos. Não inclui cookies, senhas,
 * tokens nem bytes de áudio (planejamento/08 e 14).
 */
export async function buildPendingExport(session: LocalSession, storage: SyncStorage) {
  const { profile, team } = session;
  const pending = await storage.transaction(async (tx) => {
    const documents = [];
    for (const state of await tx.listDirtyStates()) {
      documents.push({ entityType: state.entityType, entityId: state.entityId, localGeneration: state.localGeneration, serverRevision: state.serverRevision, blocked: state.blocked ?? null, document: await tx.getDocument(state.entityType, state.entityId) });
    }
    return { documents, operations: await tx.listOperations() };
  });
  return {
    format: 'louvorvisual-pendencias',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: { profileId: profile.profileId, workspaceId: profile.workspaceId, workspaceName: team?.workspaceName ?? null, userEmail: team?.userEmail ?? null },
    ...pending,
    conflicts: await listOpenConflicts(storage),
  };
}

export function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
