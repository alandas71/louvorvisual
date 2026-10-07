import type { Arrangement, Asset, Setlist, Song, Theme, ThemeRef } from '@louvorvisual/domain';
import type { PackageEntityType } from './manifest';

/** Documentos de um pacote de repertório: o repertório e tudo o que ele alcança. */
export type PackageDocuments = {
  setlist: Setlist;
  arrangements: Arrangement[];
  songs: Song[];
  assets: Asset[];
  themes: Theme[];
};

export type PackageDocument = Setlist | Arrangement | Song | Asset | Theme;

/** Ordem de dependência: quem é referenciado vem antes de quem referencia. */
export const DEPENDENCY_ORDER: readonly PackageEntityType[] = ['asset', 'theme', 'song', 'arrangement', 'setlist'];

export function documentsOf(documents: PackageDocuments, entityType: PackageEntityType): PackageDocument[] {
  if (entityType === 'setlist') return [documents.setlist];
  if (entityType === 'arrangement') return documents.arrangements;
  if (entityType === 'song') return documents.songs;
  if (entityType === 'asset') return documents.assets;
  return documents.themes;
}

export function allDocuments(documents: PackageDocuments): { entityType: PackageEntityType; document: PackageDocument }[] {
  return DEPENDENCY_ORDER.flatMap((entityType) => documentsOf(documents, entityType).map((document) => ({ entityType, document })));
}

const workspaceTheme = (ref: ThemeRef | null) => (ref?.kind === 'workspace' ? ref.themeId : null);

/**
 * Confere que o conjunto é fechado: toda referência aponta para um documento
 * do próprio pacote, do mesmo espaço e não excluído, e nada sobra sem uso.
 * Devolve a lista de problemas; vazia quando o conjunto é coerente.
 */
export function referenceProblems(documents: PackageDocuments): string[] {
  const problems: string[] = [];
  const { setlist } = documents;
  const workspaceId = setlist.workspaceId;
  const ids = (list: readonly { id: string }[], label: string) => {
    const set = new Set<string>();
    for (const { id } of list) {
      if (set.has(id)) problems.push(`${label} repetido: ${id}`);
      set.add(id);
    }
    return set;
  };
  const arrangements = ids(documents.arrangements, 'arranjo');
  const songs = ids(documents.songs, 'louvor');
  const assets = ids(documents.assets, 'arquivo');
  const themes = ids(documents.themes, 'tema');

  for (const { entityType, document } of allDocuments(documents)) {
    if (document.workspaceId !== workspaceId) problems.push(`${entityType} ${document.id} pertence a outro espaço`);
    if (document.deletedAt !== null) problems.push(`${entityType} ${document.id} está excluído`);
  }

  const usedArrangements = new Set<string>();
  const usedSongs = new Set<string>();
  const usedAssets = new Set<string>();
  const usedThemes = new Set<string>();
  const checkTheme = (ref: ThemeRef | null, owner: string) => {
    const themeId = workspaceTheme(ref);
    if (themeId === null) return;
    usedThemes.add(themeId);
    if (!themes.has(themeId)) problems.push(`${owner} usa um tema que não está no pacote: ${themeId}`);
  };

  checkTheme(setlist.themeRef, `repertório ${setlist.id}`);
  for (const item of setlist.items) {
    usedArrangements.add(item.arrangementId);
    if (!arrangements.has(item.arrangementId)) problems.push(`item ${item.id} aponta para um arranjo que não está no pacote: ${item.arrangementId}`);
  }
  for (const arrangement of documents.arrangements) {
    usedSongs.add(arrangement.songId);
    if (!songs.has(arrangement.songId)) problems.push(`arranjo ${arrangement.id} aponta para um louvor que não está no pacote: ${arrangement.songId}`);
    checkTheme(arrangement.themeRef, `arranjo ${arrangement.id}`);
    for (const binding of arrangement.audioBindings) {
      usedAssets.add(binding.assetId);
      if (!assets.has(binding.assetId)) problems.push(`arranjo ${arrangement.id} usa um arquivo que não está no pacote: ${binding.assetId}`);
    }
  }

  const unused = (all: Set<string>, used: Set<string>, label: string) => {
    for (const id of all) if (!used.has(id)) problems.push(`${label} ${id} não é usado pelo repertório`);
  };
  unused(arrangements, usedArrangements, 'arranjo');
  unused(songs, usedSongs, 'louvor');
  unused(assets, usedAssets, 'arquivo');
  unused(themes, usedThemes, 'tema');
  return problems;
}

/** Temas e fontes de fábrica que os documentos referenciam pelo ID do catálogo. */
export function usedBuiltins(documents: PackageDocuments): { themePresetIds: string[]; fontIds: string[] } {
  const presets = new Set<string>();
  const fonts = new Set<string>();
  const ref = (value: ThemeRef | null) => {
    if (value?.kind === 'builtin') presets.add(value.presetId);
  };
  ref(documents.setlist.themeRef);
  for (const arrangement of documents.arrangements) {
    ref(arrangement.themeRef);
    if (arrangement.fontId !== null) fonts.add(arrangement.fontId);
  }
  for (const theme of documents.themes) {
    if (theme.basePresetId !== null) presets.add(theme.basePresetId);
    fonts.add(theme.fontId);
  }
  return { themePresetIds: [...presets].sort(), fontIds: [...fonts].sort() };
}

/** Versões do pacote de fontes citadas pelos documentos. */
export function fontPackVersions(documents: PackageDocuments): string[] {
  return [...new Set([...documents.arrangements.map((item) => item.fontPackVersion), ...documents.themes.map((item) => item.fontPackVersion)])];
}
