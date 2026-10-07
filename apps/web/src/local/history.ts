import { documentSchemas } from '@louvorvisual/contracts';
import { touch, type Arrangement, type AuthoringContext, type IsoInstant, type Setlist, type Song, type Uuid } from '@louvorvisual/domain';
import type { LocalDatabase } from './db';
import { saveDocuments } from './repository';
import { entityStateKey, type LocalDocument, type LocalRevision, type RevisionReason } from './schema';

/** Tipos com lixeira e histórico na interface. Arquivos e temas não são editados aqui. */
export type RecoverableType = 'song' | 'arrangement' | 'setlist';

/** Prazo da lixeira no servidor (planejamento/19); depois dele o ID pode ter sido retirado. */
export const TRASH_RETENTION_DAYS = 30;

export type RecoveryErrorCode = 'not-found' | 'not-deleted' | 'in-conflict' | 'invalid' | 'song-missing' | 'unsupported';

const RECOVERY_TEXT: Record<RecoveryErrorCode, string> = {
  'not-found': 'Este item não está mais neste dispositivo.',
  'not-deleted': 'Este item já está na biblioteca.',
  'in-conflict': 'Este item está em conflito com uma alteração da equipe. Resolva o conflito em "Sincronização" antes de restaurar.',
  invalid: 'Esta cópia não pode ser lida por esta versão do aplicativo. Ela continua guardada.',
  'song-missing': 'O louvor deste arranjo foi excluído. Restaure o louvor na lixeira primeiro.',
  unsupported: 'Este tipo de cópia não pode ser restaurado por aqui.',
};

/** Recuperação recusada: nada foi gravado. */
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode) {
    super(RECOVERY_TEXT[code]);
    this.name = 'RecoveryError';
  }
}

export type TrashItem = {
  entityType: 'song' | 'setlist';
  id: Uuid;
  title: string;
  deletedAt: IsoInstant;
  /** Arranjos (louvor) ou itens (repertório) que voltam junto. */
  parts: number;
  /** Ainda não confirmado por um servidor: a exclusão só existe neste dispositivo. */
  pending: boolean;
  conflict: boolean;
};

/** Arranjos que saíram junto com o louvor: excluídos no mesmo minuto. */
const TOGETHER_MS = 60_000;

async function arrangementsDeletedWith(db: LocalDatabase, song: Song): Promise<Arrangement[]> {
  const all = (await db.arrangements.where('songId').equals(song.id).toArray()).filter((item) => item.deletedAt !== null);
  const at = Date.parse(song.deletedAt as IsoInstant);
  const together = all.filter((item) => Math.abs(Date.parse(item.deletedAt as IsoInstant) - at) <= TOGETHER_MS);
  if (together.length > 0) return together;
  // Exclusão recebida da equipe pode ter instantes diferentes: sem arranjo o louvor não abre, então volta o mais recente.
  const latest = all.sort((a, b) => (b.deletedAt as string).localeCompare(a.deletedAt as string))[0];
  return latest ? [latest] : [];
}

/** Louvores e repertórios excluídos do espaço, do mais recente para o mais antigo. */
export async function listTrash(db: LocalDatabase, workspaceId: Uuid): Promise<TrashItem[]> {
  const [songs, setlists] = await Promise.all([db.songs.where('workspaceId').equals(workspaceId).toArray(), db.setlists.where('workspaceId').equals(workspaceId).toArray()]);
  const items: TrashItem[] = [];
  for (const song of songs) {
    if (song.deletedAt === null) continue;
    const state = await db.entityStates.get(entityStateKey('song', song.id));
    items.push({ entityType: 'song', id: song.id, title: song.title, deletedAt: song.deletedAt, parts: (await arrangementsDeletedWith(db, song)).length, pending: state?.dirty === 1, conflict: Boolean(state?.conflict) });
  }
  for (const setlist of setlists) {
    if (setlist.deletedAt === null) continue;
    const state = await db.entityStates.get(entityStateKey('setlist', setlist.id));
    items.push({ entityType: 'setlist', id: setlist.id, title: setlist.title, deletedAt: setlist.deletedAt, parts: setlist.items.length, pending: state?.dirty === 1, conflict: Boolean(state?.conflict) });
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * Tira um louvor (com os arranjos que saíram junto) ou um repertório da
 * lixeira. É uma alteração local como outra qualquer: fica pendente e, em um
 * perfil de equipe, é publicada como restauração — a decisão final sobre um
 * ID já retirado é do servidor.
 */
export async function restoreFromTrash(db: LocalDatabase, entityType: 'song' | 'setlist', id: Uuid, context: Pick<AuthoringContext, 'userId' | 'now'>): Promise<void> {
  const state = await db.entityStates.get(entityStateKey(entityType, id));
  if (state?.conflict) throw new RecoveryError('in-conflict');
  if (entityType === 'setlist') {
    const setlist = await db.setlists.get(id);
    if (!setlist) throw new RecoveryError('not-found');
    if (setlist.deletedAt === null) throw new RecoveryError('not-deleted');
    await saveDocuments(db, [{ entityType: 'setlist', document: { ...touch(setlist, context), deletedAt: null } }], { now: context.now });
    return;
  }
  const song = await db.songs.get(id);
  if (!song) throw new RecoveryError('not-found');
  if (song.deletedAt === null) throw new RecoveryError('not-deleted');
  const arrangements = await arrangementsDeletedWith(db, song);
  await saveDocuments(
    db,
    [
      { entityType: 'song', document: { ...touch(song, context), deletedAt: null } },
      ...arrangements.map((arrangement) => ({ entityType: 'arrangement' as const, document: { ...touch(arrangement, context), deletedAt: null } })),
    ],
    { now: context.now },
  );
}

export type HistoryEntry = {
  id: Uuid;
  entityType: RecoverableType;
  entityId: Uuid;
  reason: RevisionReason;
  createdAt: IsoInstant;
  title: string;
  /** Para um arranjo, o louvor a que pertence. */
  songTitle: string | null;
  /** O documento atual já tem exatamente este conteúdo. */
  current: boolean;
};

const RECOVERABLE = new Set<string>(['song', 'arrangement', 'setlist']);

function titleOf(document: unknown): string {
  const fields = (document ?? {}) as { title?: unknown; name?: unknown };
  return typeof fields.title === 'string' ? fields.title : typeof fields.name === 'string' ? fields.name : 'Sem título';
}

const AUTHORED_STAMPS = ['serverRevision', 'updatedAt', 'updatedBy', 'deletedAt'] as const;
function authored(document: unknown): string {
  const copy = { ...(document as Record<string, unknown>) };
  for (const field of AUTHORED_STAMPS) delete copy[field];
  return JSON.stringify(copy);
}

function table(db: LocalDatabase, entityType: RecoverableType) {
  return (entityType === 'song' ? db.songs : entityType === 'arrangement' ? db.arrangements : db.setlists) as unknown as { get(id: Uuid): Promise<Song | Arrangement | Setlist | undefined> };
}

/** Cópias guardadas do espaço (edições, exclusões, conflitos, reparos), da mais recente para a mais antiga. */
export async function listHistory(db: LocalDatabase, workspaceId: Uuid, limit = 200): Promise<HistoryEntry[]> {
  const rows = (await db.revisions.where('workspaceId').equals(workspaceId).toArray())
    .filter((row) => RECOVERABLE.has(row.entityType) && row.reason !== 'corrupted')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    const entityType = row.entityType as RecoverableType;
    const live = await table(db, entityType).get(row.entityId);
    const songId = entityType === 'arrangement' ? (row.document as Arrangement).songId : null;
    entries.push({
      id: row.id,
      entityType,
      entityId: row.entityId,
      reason: row.reason,
      createdAt: row.createdAt,
      title: titleOf(row.document),
      songTitle: songId ? ((await db.songs.get(songId))?.title ?? null) : null,
      current: live !== undefined && live.deletedAt === null && authored(live) === authored(row.document),
    });
  }
  return entries;
}

/**
 * Restaura uma cópia do histórico como a versão atual. A versão que estava em
 * uso é guardada antes, na mesma transação, de modo que restaurar também pode
 * ser desfeito. O resultado é uma alteração local pendente: em um perfil de
 * equipe passa pelo controle de revisão como qualquer edição.
 */
export async function restoreRevision(db: LocalDatabase, revisionId: Uuid, context: Pick<AuthoringContext, 'userId' | 'now'>): Promise<{ entityType: RecoverableType; entityId: Uuid }> {
  const revision = await db.revisions.get(revisionId);
  if (!revision) throw new RecoveryError('not-found');
  if (!RECOVERABLE.has(revision.entityType) || revision.reason === 'corrupted') throw new RecoveryError('unsupported');
  const entityType = revision.entityType as RecoverableType;
  const state = await db.entityStates.get(entityStateKey(entityType, revision.entityId));
  if (state?.conflict) throw new RecoveryError('in-conflict');
  const live = await table(db, entityType).get(revision.entityId);

  const candidate = { ...(revision.document as Song), serverRevision: live?.serverRevision ?? null, deletedAt: null, updatedAt: context.now, updatedBy: context.userId };
  const parsed = (documentSchemas[entityType] as { safeParse(value: unknown): { success: boolean; data?: unknown } }).safeParse(candidate);
  if (!parsed.success) throw new RecoveryError('invalid');
  if (entityType === 'arrangement') {
    const song = await db.songs.get((parsed.data as Arrangement).songId);
    if (!song || song.deletedAt !== null) throw new RecoveryError('song-missing');
  }
  const before: LocalRevision[] = live ? [{ id: crypto.randomUUID(), entityType, entityId: revision.entityId, workspaceId: live.workspaceId, createdAt: context.now, reason: 'restore', document: live }] : [];
  await saveDocuments(db, [{ entityType, document: parsed.data } as LocalDocument], { revisions: before, now: context.now });
  return { entityType, entityId: revision.entityId };
}
