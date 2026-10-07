import type { Uuid } from './common';
import type { SectionKind, SongSection } from './song';
import { normalizeForComparison, normalizeForSearch, normalizeLyrics } from './text';

/** Limite inicial de caracteres por letra (planejamento/04). */
export const MAX_LYRICS_CHARS = 100_000;

export type LyricsWarningCode =
  /** Bloco sem marcador: tipo desconhecido, rótulo "Trecho N". */
  | 'unlabeled-block'
  /** Linha entre colchetes que não é um marcador conhecido; ficou como texto. */
  | 'unknown-marker'
  /** Bloco sem marcador igual a um anterior; tratado como repetição. */
  | 'repeated-block'
  /** Blocos quase iguais (pontuação, caixa ou acentos); mantidos separados. */
  | 'similar-block'
  /** Mesmo marcador com textos diferentes; mantidos como seções distintas. */
  | 'same-label-different-text'
  /** Marcador sem texto interpretado como repetição da seção de mesmo rótulo. */
  | 'empty-marker-repeat'
  /** Marcador com "2x": gerou mais de uma ocorrência. */
  | 'repeat-count';

export type LyricsWarning = {
  code: LyricsWarningCode;
  sectionId: Uuid;
  /** Linha do marcador ou do início do bloco na letra, começando em 1. */
  line: number;
  message: string;
};

export type ParsedLyrics = {
  /** Seções textuais distintas, na ordem em que aparecem. */
  sections: SongSection[];
  /** Ordem da letra: um ID de seção por aparição, com repetições. */
  sequence: Uuid[];
  warnings: LyricsWarning[];
};

const KNOWN_MARKERS: Record<string, { kind: SectionKind; label: string }> = {
  estrofe: { kind: 'verse', label: 'Estrofe' },
  verso: { kind: 'verse', label: 'Verso' },
  refrao: { kind: 'chorus', label: 'Refrão' },
  coro: { kind: 'chorus', label: 'Coro' },
  ponte: { kind: 'bridge', label: 'Ponte' },
  introducao: { kind: 'intro', label: 'Introdução' },
  intro: { kind: 'intro', label: 'Introdução' },
  instrumental: { kind: 'instrumental', label: 'Instrumental' },
  interludio: { kind: 'instrumental', label: 'Interlúdio' },
  solo: { kind: 'instrumental', label: 'Solo' },
};

/** Limite de repetições aceito em "2x"; acima disso o marcador é ignorado como contagem. */
const MAX_MARKER_REPEAT = 8;

type Marker = { kind: SectionKind; label: string; repeat: number };

/**
 * Marcador só vale quando ocupa a linha inteira e está na lista conhecida:
 * `[Estrofe 1]`, `[Refrão]`, `[Refrão 2x]`, `[Ponte]`. Qualquer outra coisa
 * entre colchetes continua sendo texto da letra.
 */
export function parseMarker(line: string): Marker | null {
  const match = /^\[([^[\]]+)\]$/.exec(line.trim());
  if (!match?.[1]) return null;
  const parts = /^([a-z]+)(?: (\d{1,2}))?(?: (?:(\d{1,2}) ?x|x ?(\d{1,2})))?$/.exec(normalizeForSearch(match[1]));
  if (!parts?.[1]) return null;
  const known = KNOWN_MARKERS[parts[1]];
  if (!known) return null;
  const repeat = Number(parts[3] ?? parts[4] ?? 1);
  if (repeat < 1 || repeat > MAX_MARKER_REPEAT) return null;
  return { kind: known.kind, label: parts[2] ? `${known.label} ${Number(parts[2])}` : known.label, repeat };
}

type Block = { marker: Marker | null; lines: string[]; line: number };

function splitBlocks(lines: string[]): { blocks: Block[]; unknownMarkers: Map<Block, number[]> } {
  const blocks: Block[] = [];
  const unknownMarkers = new Map<Block, number[]>();
  let current: Block | null = null;
  const close = () => {
    if (current && (current.marker || current.lines.length > 0)) blocks.push(current);
    current = null;
  };

  lines.forEach((line, index) => {
    const marker = parseMarker(line);
    if (marker) {
      close();
      current = { marker, lines: [], line: index + 1 };
      return;
    }
    if (line.trim() === '') {
      // Linha vazia logo depois do marcador não encerra o bloco marcado.
      if (current && current.lines.length > 0) close();
      return;
    }
    current ??= { marker: null, lines: [], line: index + 1 };
    current.lines.push(line);
    if (/^\[[^[\]]+\]$/.test(line.trim())) {
      unknownMarkers.set(current, [...(unknownMarkers.get(current) ?? []), index + 1]);
    }
  });
  close();
  return { blocks, unknownMarkers };
}

/**
 * Sugere seções e a ordem da letra com regras determinísticas. Blocos são
 * separados por linhas vazias ou por marcadores; repetição só é assumida para
 * texto idêntico, e toda decisão incerta gera um aviso para revisão.
 */
export function parseLyrics(rawLyrics: string, newId: () => Uuid): ParsedLyrics {
  const { blocks, unknownMarkers } = splitBlocks(normalizeLyrics(rawLyrics).split('\n'));
  const sections: SongSection[] = [];
  const sequence: Uuid[] = [];
  const warnings: LyricsWarning[] = [];
  let unlabeled = 0;

  const warn = (code: LyricsWarningCode, sectionId: Uuid, line: number, message: string) =>
    warnings.push({ code, sectionId, line, message });

  for (const block of blocks) {
    const text = block.lines.join('\n');
    const { marker } = block;
    const repeat = marker?.repeat ?? 1;
    let section: SongSection | undefined;

    if (marker && text === '') {
      // `[Refrão]` sozinho costuma indicar "cantar o refrão de novo".
      const previous = sections.filter((item) => item.label === marker.label && item.text !== '').at(-1);
      if (previous) {
        section = previous;
        warn('empty-marker-repeat', previous.id, block.line, `[${marker.label}] sem texto foi tratado como repetição de "${previous.label}".`);
      } else {
        section = sections.find((item) => item.label === marker.label && item.text === '');
      }
    } else if (marker) {
      section = sections.find((item) => item.label === marker.label && item.kind === marker.kind && item.text === text);
    } else {
      section = sections.find((item) => item.text === text);
      if (section) {
        warn('repeated-block', section.id, block.line, `Bloco igual a "${section.label}"; tratado como repetição.`);
      }
    }

    if (!section) {
      const created: SongSection = marker
        ? { id: newId(), kind: marker.kind, label: marker.label, text, order: sections.length, detection: 'explicit' }
        : { id: newId(), kind: 'unknown', label: `Trecho ${++unlabeled}`, text, order: sections.length, detection: 'suggested' };

      if (!marker) {
        warn('unlabeled-block', created.id, block.line, `"${created.label}" não tem marcador; confira o tipo.`);
      }
      const comparable = normalizeForComparison(text);
      const similar = comparable === '' ? undefined : sections.find((item) => normalizeForComparison(item.text) === comparable);
      if (similar) {
        warn('similar-block', created.id, block.line, `"${created.label}" é quase igual a "${similar.label}"; as diferenças foram mantidas.`);
      } else if (marker && sections.some((item) => item.label === marker.label && item.text !== '')) {
        warn('same-label-different-text', created.id, block.line, `Há mais de um "${marker.label}" com textos diferentes.`);
      }
      sections.push(created);
      section = created;
    }

    for (const line of unknownMarkers.get(block) ?? []) {
      warn('unknown-marker', section.id, line, 'Marcador não reconhecido; a linha ficou como texto da letra.');
    }
    if (repeat > 1) {
      warn('repeat-count', section.id, block.line, `"${section.label}" foi incluído ${repeat} vezes pela indicação ${repeat}x.`);
    }
    for (let count = 0; count < repeat; count += 1) sequence.push(section.id);
  }

  return { sections, sequence, warnings };
}
