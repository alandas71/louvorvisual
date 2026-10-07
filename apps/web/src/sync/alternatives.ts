import { duplicateArrangement, duplicateSong, type Arrangement, type AuthoringContext, type Setlist, type Song } from '@louvorvisual/domain';
import type { AlternativeCopy, ConflictRecord, SyncDoc } from '@louvorvisual/sync';
import { listArrangements } from '@/local/repository';
import type { LocalDatabase } from '@/local/db';

const SUFFIX = ' (minha versão)';

/**
 * Monta a função que transforma a variante local de um conflito em registros
 * novos, com novos IDs (planejamento/09, "Criar alternativa"). Para um louvor,
 * os arranjos locais acompanham a cópia, para que ela seja apresentável.
 */
export async function alternativeBuilder(db: LocalDatabase, conflict: ConflictRecord, context: AuthoringContext): Promise<(local: SyncDoc) => AlternativeCopy[]> {
  if (conflict.entityType === 'song') {
    // Se o louvor foi excluído pela equipe, os arranjos saíram junto: a cópia
    // os traz de volta, para que a alternativa continue apresentável.
    const active = await listArrangements(db, conflict.entityId);
    const arrangements = active.length > 0 ? active : (await db.arrangements.where('songId').equals(conflict.entityId).toArray()).map((arrangement) => ({ ...arrangement, deletedAt: null }));
    return (local) => {
      const source = { ...(local as Song), deletedAt: null };
      const copy = duplicateSong(source, arrangements, context, `${source.title}${SUFFIX}`);
      return [{ entityType: 'song', document: copy.song as SyncDoc }, ...copy.arrangements.map((document) => ({ entityType: 'arrangement' as const, document: document as SyncDoc }))];
    };
  }
  if (conflict.entityType === 'arrangement') {
    return (local) => {
      const source = { ...(local as Arrangement), deletedAt: null };
      const copy = { ...duplicateArrangement(source, context, { name: `${source.name}${SUFFIX}` }), serverRevision: null };
      return [{ entityType: 'arrangement', document: copy as SyncDoc }];
    };
  }
  if (conflict.entityType === 'setlist') {
    return (local) => {
      const source = local as Setlist;
      const copy: Setlist = {
        ...source,
        id: context.newId(),
        title: `${source.title}${SUFFIX}`,
        serverRevision: null,
        createdBy: context.userId,
        updatedBy: context.userId,
        createdAt: context.now,
        updatedAt: context.now,
        deletedAt: null,
        items: source.items.map((item) => ({ ...item, id: context.newId() })),
      };
      return [{ entityType: 'setlist', document: copy as SyncDoc }];
    };
  }
  return () => [];
}
