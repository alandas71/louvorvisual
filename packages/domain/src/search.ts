import type { IsoInstant, Uuid } from './common';
import type { Song } from './song';
import { normalizeForComparison, normalizeForSearch } from './text';

/** Linha do índice local de busca; o texto exibido continua vindo do documento. */
export type SongSearchEntry = {
  id: Uuid;
  workspaceId: Uuid;
  title: string;
  artist: string | null;
  titleKey: string;
  artistKey: string;
  tagsKey: string;
  lyricsKey: string;
  updatedAt: IsoInstant;
  deletedAt: IsoInstant | null;
};

export function buildSongSearchEntry(song: Song): SongSearchEntry {
  return {
    id: song.id,
    workspaceId: song.workspaceId,
    title: song.title,
    artist: song.artist,
    titleKey: normalizeForSearch(song.title),
    artistKey: normalizeForSearch(song.artist ?? ''),
    tagsKey: normalizeForSearch(song.tags.join(' ')),
    lyricsKey: normalizeForSearch(song.rawLyrics),
    updatedAt: song.updatedAt,
    deletedAt: song.deletedAt,
  };
}

function tokenScore(entry: SongSearchEntry, token: string): number | null {
  if (entry.titleKey.startsWith(token)) return 0;
  if (entry.titleKey.includes(token)) return 1;
  if (entry.artistKey.includes(token)) return 2;
  if (entry.tagsKey.includes(token)) return 3;
  if (entry.lyricsKey.includes(token)) return 4;
  return null;
}

/**
 * Busca por título, artista, etiquetas e letra, ignorando acentos e caixa.
 * Todas as palavras precisam aparecer; título vale mais do que letra. Consulta
 * vazia devolve tudo em ordem alfabética.
 */
export function searchSongEntries(entries: readonly SongSearchEntry[], query: string): SongSearchEntry[] {
  const tokens = normalizeForSearch(query).split(' ').filter(Boolean);
  const scored: { entry: SongSearchEntry; score: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      const value = tokenScore(entry, token);
      if (value === null) {
        matched = false;
        break;
      }
      score += value;
    }
    if (matched) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.titleKey.localeCompare(b.entry.titleKey) || a.entry.id.localeCompare(b.entry.id))
    .map((item) => item.entry);
}

/** Louvores com o mesmo título, sem contar acentos e pontuação. É só um aviso: nunca bloqueia nem sobrescreve. */
export function findSimilarSongs(entries: readonly SongSearchEntry[], title: string, ignoreId: Uuid | null = null): SongSearchEntry[] {
  const key = normalizeForComparison(title);
  if (key === '') return [];
  return entries.filter((entry) => entry.id !== ignoreId && entry.deletedAt === null && normalizeForComparison(entry.title) === key);
}
