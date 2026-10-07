import type { AggregateMeta, Uuid } from './common';

export const SECTION_KINDS = ['verse', 'chorus', 'bridge', 'intro', 'instrumental', 'unknown'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Origem da classificação: marcador explícito, sugestão do parser ou edição manual. */
export const SECTION_DETECTIONS = ['explicit', 'suggested', 'manual'] as const;
export type SectionDetection = (typeof SECTION_DETECTIONS)[number];

export type SongSection = {
  id: Uuid;
  kind: SectionKind;
  label: string;
  text: string;
  order: number;
  detection: SectionDetection;
};

/** Louvor: metadados, letra original preservada e sua estrutura em seções. */
export type Song = AggregateMeta & {
  id: Uuid;
  title: string;
  artist: string | null;
  authors: string[];
  musicalKey: string | null;
  tags: string[];
  notes: string;
  rawLyrics: string;
  sections: SongSection[];
};
