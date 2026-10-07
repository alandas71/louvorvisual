import { orderedSetlistItems, touch, type Arrangement, type AuthoringContext, type Setlist, type SetlistItem, type Song, type Uuid } from '@louvorvisual/domain';
import type { LocalDatabase } from './db';
import { saveDocuments } from './repository';

/** Repertórios ativos do espaço: primeiro os de culto mais recente; sem data, por criação. */
export async function listSetlists(db: LocalDatabase, workspaceId: Uuid): Promise<Setlist[]> {
  const rows = await db.setlists.where('workspaceId').equals(workspaceId).toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((a, b) => (b.serviceDate ?? '').localeCompare(a.serviceDate ?? '') || b.createdAt.localeCompare(a.createdAt));
}

export async function getSetlist(db: LocalDatabase, setlistId: Uuid): Promise<Setlist | null> {
  const setlist = await db.setlists.get(setlistId);
  return setlist && setlist.deletedAt === null ? setlist : null;
}

/** Item com o arranjo e o louvor que ele referencia; `null` quando saiu da biblioteca. */
export type SetlistEntry = { item: SetlistItem; arrangement: Arrangement | null; song: Song | null };

export async function resolveSetlist(db: LocalDatabase, setlist: Pick<Setlist, 'items'>): Promise<SetlistEntry[]> {
  return Promise.all(
    orderedSetlistItems(setlist.items).map(async (item) => {
      const found = await db.arrangements.get(item.arrangementId);
      const arrangement = found && found.deletedAt === null ? found : null;
      const song = arrangement ? await db.songs.get(arrangement.songId) : undefined;
      return { item, arrangement, song: song && song.deletedAt === null ? song : null };
    }),
  );
}

export type ArrangementChoice = { arrangementId: Uuid; songId: Uuid; title: string; artist: string | null; arrangementName: string };

/** Todos os arranjos ativos do espaço, para escolher o que entra no repertório. */
export async function listArrangementChoices(db: LocalDatabase, workspaceId: Uuid): Promise<ArrangementChoice[]> {
  const [songs, arrangements] = await Promise.all([db.songs.where('workspaceId').equals(workspaceId).toArray(), db.arrangements.where('workspaceId').equals(workspaceId).toArray()]);
  const songById = new Map(songs.filter((song) => song.deletedAt === null).map((song) => [song.id, song]));
  return arrangements
    .filter((arrangement) => arrangement.deletedAt === null && songById.has(arrangement.songId))
    .map((arrangement) => {
      const song = songById.get(arrangement.songId) as Song;
      return { arrangementId: arrangement.id, songId: song.id, title: song.title, artist: song.artist, arrangementName: arrangement.name };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') || a.arrangementName.localeCompare(b.arrangementName, 'pt-BR'));
}

/** Exclusão sincronizável do repertório; a preparação offline dele deixa de existir. */
export async function deleteSetlist(db: LocalDatabase, setlistId: Uuid, context: Pick<AuthoringContext, 'userId' | 'now'>): Promise<void> {
  const setlist = await getSetlist(db, setlistId);
  if (!setlist) return;
  await saveDocuments(db, [{ entityType: 'setlist', document: { ...touch(setlist, context), deletedAt: context.now } }]);
  await db.offlinePackages.delete(setlistId);
}
