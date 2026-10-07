import type { Arrangement, SlideOccurrence } from './arrangement';
import { FONT_PACK_VERSION } from './catalog';
import { SCHEMA_VERSION, type AggregateMeta, type IsoInstant, type Uuid } from './common';
import { MAX_LYRICS_CHARS, parseLyrics, type ParsedLyrics } from './lyrics';
import { generateOccurrences, type SplitOptions } from './slides';
import type { Song, SongSection } from './song';
import type { ThemeRef } from './theme';

/** Quem está escrevendo e como gerar IDs e instantes; injetado para manter as regras puras. */
export type AuthoringContext = {
  workspaceId: Uuid;
  userId: Uuid;
  now: IsoInstant;
  newId: () => Uuid;
};

export type SongInput = {
  title: string;
  artist?: string | null;
  authors?: string[];
  musicalKey?: string | null;
  tags?: string[];
  notes?: string;
  rawLyrics: string;
};

export type SongInputIssue = 'title-required' | 'lyrics-too-long';

export function songInputIssues(input: Pick<SongInput, 'title' | 'rawLyrics'>): SongInputIssue[] {
  const issues: SongInputIssue[] = [];
  if (input.title.trim() === '') issues.push('title-required');
  if (input.rawLyrics.length > MAX_LYRICS_CHARS) issues.push('lyrics-too-long');
  return issues;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

/** Separa "a, b; c" em itens sem vazios nem repetição. */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))];
}

function newMeta(context: AuthoringContext): AggregateMeta {
  return {
    workspaceId: context.workspaceId,
    schemaVersion: SCHEMA_VERSION,
    serverRevision: null,
    createdBy: context.userId,
    updatedBy: context.userId,
    createdAt: context.now,
    updatedAt: context.now,
    deletedAt: null,
  };
}

/** Marca uma alteração local; a revisão do servidor só muda com confirmação dele. */
export function touch<T extends AggregateMeta>(document: T, context: Pick<AuthoringContext, 'userId' | 'now'>): T {
  return { ...document, updatedBy: context.userId, updatedAt: context.now };
}

/**
 * Cria o louvor guardando a letra exatamente como recebida em `rawLyrics`; a
 * análise trabalha sobre uma cópia normalizada e só produz sugestões.
 */
export function createSong(input: SongInput, context: AuthoringContext): { song: Song; parsed: ParsedLyrics } {
  const parsed = parseLyrics(input.rawLyrics, context.newId);
  const song: Song = {
    ...newMeta(context),
    id: context.newId(),
    title: input.title.trim(),
    artist: optionalText(input.artist),
    authors: input.authors ?? [],
    musicalKey: optionalText(input.musicalKey),
    tags: input.tags ?? [],
    notes: input.notes ?? '',
    rawLyrics: input.rawLyrics,
    sections: parsed.sections,
  };
  return { song, parsed };
}

export type ArrangementOptions = SplitOptions & {
  name?: string;
  themeRef: ThemeRef;
};

/** Arranjo inicial: a sequência sugerida pela letra, sem tempos e sem áudio. */
export function createArrangement(
  song: Pick<Song, 'id' | 'serverRevision'>,
  parsed: Pick<ParsedLyrics, 'sections' | 'sequence'>,
  context: AuthoringContext,
  options: ArrangementOptions,
): Arrangement {
  return {
    ...newMeta(context),
    id: context.newId(),
    songId: song.id,
    name: options.name?.trim() || 'Culto',
    basedOnSongRevision: song.serverRevision,
    themeRef: options.themeRef,
    themeOverrides: null,
    fontId: null,
    fontPackVersion: FONT_PACK_VERSION,
    occurrences: generateOccurrences(parsed, context.newId, options),
    audioBindings: [],
    selectedAudioBindingId: null,
    defaultMode: 'manual',
  };
}

/**
 * Cópia independente de um arranjo: novos IDs de arranjo, ocorrências e
 * faixas, com as marcações remapeadas. Serve para experimentar outros tempos.
 */
export function duplicateArrangement(source: Arrangement, context: AuthoringContext, overrides: { name: string; songId?: Uuid }): Arrangement {
  const occurrenceIds = new Map(source.occurrences.map((occurrence) => [occurrence.id, context.newId()]));
  const bindingIds = new Map(source.audioBindings.map((binding) => [binding.id, context.newId()]));
  const occurrences: SlideOccurrence[] = source.occurrences.map((occurrence) => ({
    ...occurrence,
    id: occurrenceIds.get(occurrence.id) as Uuid,
  }));
  return {
    ...source,
    ...newMeta(context),
    id: context.newId(),
    songId: overrides.songId ?? source.songId,
    name: overrides.name,
    occurrences,
    audioBindings: source.audioBindings.map((binding) => ({
      ...binding,
      id: bindingIds.get(binding.id) as Uuid,
      cues: binding.cues.map((cue) => ({ ...cue, occurrenceId: occurrenceIds.get(cue.occurrenceId) as Uuid })),
    })),
    selectedAudioBindingId: source.selectedAudioBindingId ? (bindingIds.get(source.selectedAudioBindingId) ?? null) : null,
  };
}

/** Cópia de um louvor com seus arranjos; nenhum ID é compartilhado com o original. */
export function duplicateSong(
  source: Song,
  arrangements: readonly Arrangement[],
  context: AuthoringContext,
  title: string,
): { song: Song; arrangements: Arrangement[] } {
  const sectionIds = new Map(source.sections.map((section) => [section.id, context.newId()]));
  const song: Song = {
    ...source,
    ...newMeta(context),
    id: context.newId(),
    title,
    sections: source.sections.map((section) => ({ ...section, id: sectionIds.get(section.id) as Uuid })),
  };
  const copies = arrangements.map((arrangement) => {
    const copy = duplicateArrangement(arrangement, context, { name: arrangement.name, songId: song.id });
    return {
      ...copy,
      basedOnSongRevision: null,
      occurrences: copy.occurrences.map((occurrence) => ({
        ...occurrence,
        sourceSectionId: occurrence.sourceSectionId ? (sectionIds.get(occurrence.sourceSectionId) ?? null) : null,
      })),
    };
  });
  return { song, arrangements: copies };
}

/**
 * Analisa de novo a letra reaproveitando o que já foi revisado: seção com o
 * mesmo rótulo e texto mantém ID e classificação manual.
 */
export function reparseLyrics(rawLyrics: string, previous: readonly SongSection[], newId: () => Uuid): ParsedLyrics {
  const parsed = parseLyrics(rawLyrics, newId);
  const used = new Set<Uuid>();
  const replaced = new Map<Uuid, Uuid>();
  const sections = parsed.sections.map((section) => {
    const match = previous.find(
      (item) => !used.has(item.id) && item.text === section.text && (item.label === section.label || item.detection === 'manual'),
    );
    if (!match) return section;
    used.add(match.id);
    replaced.set(section.id, match.id);
    return match.detection === 'manual'
      ? { ...section, id: match.id, kind: match.kind, label: match.label, detection: match.detection }
      : { ...section, id: match.id };
  });
  const remap = (id: Uuid) => replaced.get(id) ?? id;
  return {
    sections,
    sequence: parsed.sequence.map(remap),
    warnings: parsed.warnings.map((warning) => ({ ...warning, sectionId: remap(warning.sectionId) })),
  };
}
