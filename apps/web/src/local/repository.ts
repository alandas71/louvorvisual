import { documentSchemas } from '@louvorvisual/contracts';
import {
  buildSongSearchEntry,
  touch,
  type Arrangement,
  type AuthoringContext,
  type IsoInstant,
  type Setlist,
  type Song,
  type Uuid,
} from '@louvorvisual/domain';
import type { Table } from 'dexie';
import type { LocalDatabase } from './db';
import {
  entityStateKey,
  type LocalDocument,
  type LocalEntityState,
  type LocalEntityType,
  type LocalProfile,
  type LocalRevision,
  type SongIndexRow,
} from './schema';

/** Limite inicial de 1 MiB de JSON UTF-8 por agregado sincronizável (planejamento/04). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export type LocalSaveErrorCode = 'invalid-document' | 'document-too-large' | 'quota' | 'storage';

/** Falha de gravação: nada foi escrito, e o conteúdo continua só na memória de quem chamou. */
export class LocalSaveError extends Error {
  constructor(
    readonly code: LocalSaveErrorCode,
    message: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'LocalSaveError';
    this.details = options?.details;
  }
  readonly details: unknown;
}

export function isQuotaError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const { name, inner } = current as { name?: string; inner?: unknown };
    if (name === 'QuotaExceededError') return true;
    current = inner;
  }
  return false;
}

function validated(write: LocalDocument): LocalDocument {
  const result = (documentSchemas[write.entityType] as { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown } } }).safeParse(write.document);
  if (!result.success) {
    throw new LocalSaveError('invalid-document', 'O conteúdo não passou na validação e não foi gravado.', { details: result.error.issues });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result.data)).length;
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new LocalSaveError('document-too-large', 'O conteúdo passa do limite de 1 MiB por louvor ou arranjo.', { details: { bytes } });
  }
  return write;
}

export type SavedGeneration = { key: string; localGeneration: number };

/** Intervalo mínimo entre duas cópias automáticas do mesmo documento. */
export const HISTORY_INTERVAL_MS = 10 * 60_000;
/** Cópias automáticas (`edit`) guardadas por documento; as mais antigas saem primeiro. */
export const HISTORY_LIMIT = 30;

const LOCAL_REASONS = new Set<LocalRevision['reason']>(['edit', 'delete', 'regenerate', 'restore']);

/**
 * Histórico local: antes de substituir um louvor, arranjo ou repertório, guarda
 * a versão anterior — sempre ao excluir, e no máximo uma vez a cada
 * `HISTORY_INTERVAL_MS` ao editar (a digitação grava várias vezes por segundo).
 * Roda na mesma transação da gravação.
 */
async function checkpoint(db: LocalDatabase, write: LocalDocument, now: IsoInstant, skip: ReadonlySet<string>): Promise<void> {
  if (write.entityType === 'asset' || write.entityType === 'theme') return;
  const { entityType, document } = write;
  if (skip.has(entityStateKey(entityType, document.id))) return;
  const table = entityType === 'song' ? db.songs : entityType === 'arrangement' ? db.arrangements : db.setlists;
  const previous = await (table as Table<Song | Arrangement | Setlist, string>).get(document.id);
  if (!previous || JSON.stringify(previous) === JSON.stringify(document)) return;
  const deleting = previous.deletedAt === null && document.deletedAt !== null;
  const rows = await db.revisions.where('[entityType+entityId]').equals([entityType, document.id]).toArray();
  const lastLocal = rows.filter((row) => LOCAL_REASONS.has(row.reason)).reduce((latest, row) => (row.createdAt > latest ? row.createdAt : latest), '');
  if (!deleting && lastLocal !== '' && Date.parse(now) - Date.parse(lastLocal) < HISTORY_INTERVAL_MS) return;
  await db.revisions.put({ id: crypto.randomUUID(), entityType, entityId: document.id, workspaceId: previous.workspaceId, createdAt: now, reason: deleting ? 'delete' : 'edit', document: previous });
  const edits = rows.filter((row) => row.reason === 'edit').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (edits.length >= HISTORY_LIMIT) await db.revisions.bulkDelete(edits.slice(0, edits.length - HISTORY_LIMIT + 1).map((row) => row.id));
}

/**
 * Grava um documento já validado e a sua marcação de pendência. Só pode ser
 * chamada dentro de uma transação que inclua a tabela do documento,
 * `entityStates` e, para louvores, `songIndex`.
 */
export async function writeDocument(db: LocalDatabase, write: LocalDocument): Promise<SavedGeneration> {
  const { document } = write;
  const key = entityStateKey(write.entityType, document.id);
  const previous = await db.entityStates.get(key);
  const state: LocalEntityState = {
    key,
    entityType: write.entityType,
    entityId: document.id,
    workspaceId: document.workspaceId,
    serverRevision: previous?.serverRevision ?? ('serverRevision' in document ? document.serverRevision : null),
    localGeneration: (previous?.localGeneration ?? 0) + 1,
    dirty: 1,
    lastAckSnapshot: previous?.lastAckSnapshot ?? null,
    // Um conflito aberto, uma versão remota adiada ou uma recusa do servidor
    // continuam valendo depois de uma edição local.
    conflict: previous?.conflict ?? null,
    deferredRemote: previous?.deferredRemote ?? null,
    blocked: previous?.blocked ?? null,
    updatedAt: document.updatedAt,
  };
  if (write.entityType === 'song') {
    await db.songs.put(write.document);
    await db.songIndex.put(buildSongSearchEntry(write.document));
  } else if (write.entityType === 'arrangement') {
    await db.arrangements.put(write.document);
  } else if (write.entityType === 'setlist') {
    await db.setlists.put(write.document);
  } else if (write.entityType === 'theme') {
    await db.themes.put(write.document);
  } else {
    await db.assets.put(write.document);
  }
  await db.entityStates.put(state);
  return { key, localGeneration: state.localGeneration };
}

/** Valida um documento como `saveDocuments` faz; falha com `LocalSaveError` sem gravar nada. */
export function validateDocument(write: LocalDocument): LocalDocument {
  return validated(write);
}

/**
 * Grava os documentos e a marcação de pendência de cada um em uma única
 * transação: ou tudo fica gravado, ou nada muda. A validação acontece antes,
 * fora da transação, que só contém operações do banco.
 */
export async function saveDocuments(
  db: LocalDatabase,
  writes: readonly LocalDocument[],
  options: { revisions?: readonly LocalRevision[]; now?: IsoInstant } = {},
): Promise<SavedGeneration[]> {
  const checked = writes.map(validated);
  const now = options.now ?? new Date().toISOString();
  // Quem já traz a cópia anterior (regenerar, restaurar) não ganha outra automática.
  const explicit = new Set((options.revisions ?? []).map((revision) => entityStateKey(revision.entityType as LocalEntityType, revision.entityId)));
  try {
    return await db.transaction('rw', [db.songs, db.arrangements, db.setlists, db.assets, db.themes, db.entityStates, db.songIndex, db.revisions], async () => {
      const saved: SavedGeneration[] = [];
      for (const write of checked) {
        await checkpoint(db, write, now, explicit);
        saved.push(await writeDocument(db, write));
      }
      if (options.revisions?.length) await db.revisions.bulkPut([...options.revisions]);
      return saved;
    });
  } catch (error) {
    if (error instanceof LocalSaveError) throw error;
    if (isQuotaError(error)) {
      throw new LocalSaveError('quota', 'Não há espaço neste dispositivo para gravar. O conteúdo anterior continua intacto.', { cause: error });
    }
    throw new LocalSaveError('storage', 'Não foi possível gravar neste dispositivo.', { cause: error });
  }
}

/** Perfil pessoal do dispositivo, criado na primeira abertura; não depende de servidor. */
export async function ensureProfile(
  db: LocalDatabase,
  newId: () => Uuid,
  now: IsoInstant,
  team?: Pick<LocalProfile, 'profileId' | 'workspaceId' | 'userId' | 'deviceId'>,
): Promise<LocalProfile> {
  return db.transaction('rw', db.meta, async () => {
    const existing = await db.meta.get('profile');
    if (existing) return existing;
    // Perfil de equipe: os IDs vêm da conta e do espaço; o pessoal gera os seus.
    const profile: LocalProfile = team
      ? { key: 'profile', kind: 'team', ...team, createdAt: now }
      : { key: 'profile', kind: 'personal', profileId: newId(), workspaceId: newId(), userId: newId(), deviceId: newId(), createdAt: now };
    await db.meta.add(profile);
    return profile;
  });
}

/** Índice de busca dos louvores não excluídos do espaço. */
export async function listSongIndex(db: LocalDatabase, workspaceId: Uuid): Promise<SongIndexRow[]> {
  const rows = await db.songIndex.where('workspaceId').equals(workspaceId).toArray();
  return rows.filter((row) => row.deletedAt === null);
}

export async function getSong(db: LocalDatabase, songId: Uuid): Promise<Song | null> {
  const song = await db.songs.get(songId);
  return song && song.deletedAt === null ? song : null;
}

/** Arranjos ativos de um louvor, do mais antigo para o mais novo. */
export async function listArrangements(db: LocalDatabase, songId: Uuid): Promise<Arrangement[]> {
  const rows = await db.arrangements.where('songId').equals(songId).toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function getEntityState(db: LocalDatabase, entityType: LocalEntityType | 'theme', entityId: Uuid): Promise<LocalEntityState | undefined> {
  return db.entityStates.get(entityStateKey(entityType, entityId));
}

/** Documentos gravados aqui que ainda não foram confirmados por um servidor. */
export function countPending(db: LocalDatabase, workspaceId: Uuid): Promise<number> {
  return db.entityStates.where('[workspaceId+dirty]').equals([workspaceId, 1]).count();
}

/**
 * Exclusão sincronizável: o louvor e seus arranjos recebem `deletedAt` e ficam
 * pendentes; nada é removido fisicamente.
 */
export async function deleteSong(db: LocalDatabase, songId: Uuid, context: Pick<AuthoringContext, 'userId' | 'now'>): Promise<void> {
  const song = await db.songs.get(songId);
  if (!song || song.deletedAt !== null) return;
  const arrangements = await listArrangements(db, songId);
  await saveDocuments(db, [
    { entityType: 'song', document: { ...touch(song, context), deletedAt: context.now } },
    ...arrangements.map((arrangement) => ({
      entityType: 'arrangement' as const,
      document: { ...touch(arrangement, context), deletedAt: context.now },
    })),
  ]);
}

/** Revisões guardadas de um documento, da mais recente para a mais antiga. */
export async function listRevisions(db: LocalDatabase, entityType: LocalEntityType, entityId: Uuid): Promise<LocalRevision[]> {
  const rows = await db.revisions.where('[entityType+entityId]').equals([entityType, entityId]).toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
