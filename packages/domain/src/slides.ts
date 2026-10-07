import type { SlideOccurrence } from './arrangement';
import type { Uuid } from './common';
import type { ParsedLyrics } from './lyrics';
import type { ThemeStyle } from './theme';

/** Ponto de partida: até quatro linhas visuais por slide (planejamento/04). */
export const DEFAULT_MAX_LINES_PER_SLIDE = 4;
/** Limite inicial de ocorrências por arranjo. */
export const MAX_OCCURRENCES = 500;

const REFERENCE_HEIGHT_PX = 1080;

export type SplitOptions = {
  maxLines?: number;
  /**
   * Linhas visuais que uma linha de texto ocupa depois de medida com a fonte
   * carregada. Sem medidor, cada linha de texto conta como uma.
   */
  visualLines?: (line: string) => number;
};

/** Linhas que cabem na área útil do tema, sem passar do padrão de quatro. */
export function maxLinesForStyle(style: Pick<ThemeStyle, 'fontSizePx' | 'lineHeight' | 'margins'>): number {
  const usable = REFERENCE_HEIGHT_PX * (1 - (2 * style.margins.verticalPercent) / 100);
  const fits = Math.floor(usable / (style.fontSizePx * style.lineHeight));
  return Math.max(1, Math.min(DEFAULT_MAX_LINES_PER_SLIDE, fits));
}

/**
 * Divide o texto de uma seção em slides nas quebras de linha existentes,
 * equilibrando os grupos (seis linhas viram 3 + 3, não 4 + 2). Nenhuma linha é
 * cortada nem descartada: juntar os slides com `\n` devolve o texto recebido.
 */
export function splitTextIntoSlides(text: string, options: SplitOptions = {}): string[] {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES_PER_SLIDE);
  const lines = text.split('\n');
  const weights = lines.map((line) => Math.max(1, Math.ceil(options.visualLines?.(line) ?? 1)));

  let remaining = weights.reduce((sum, weight) => sum + weight, 0);
  let slidesLeft = Math.ceil(remaining / maxLines);
  const slides: string[] = [];
  let current: string[] = [];
  let currentWeight = 0;

  lines.forEach((line, index) => {
    const weight = weights[index] ?? 1;
    const target = Math.ceil(remaining / slidesLeft);
    if (current.length > 0 && (currentWeight + weight > maxLines || currentWeight >= target)) {
      slides.push(current.join('\n'));
      remaining -= currentWeight;
      slidesLeft = Math.max(1, slidesLeft - 1);
      current = [];
      currentWeight = 0;
    }
    current.push(line);
    currentWeight += weight;
  });
  slides.push(current.join('\n'));
  return slides;
}

/**
 * Cria a sequência inicial na ordem da letra. Cada aparição recebe ID próprio
 * e começa sem temporizador (`null`), inclusive as repetições.
 */
export function generateOccurrences(
  parsed: Pick<ParsedLyrics, 'sections' | 'sequence'>,
  newId: () => Uuid,
  options: SplitOptions = {},
): SlideOccurrence[] {
  const occurrences: SlideOccurrence[] = [];
  for (const sectionId of parsed.sequence) {
    const section = parsed.sections.find((item) => item.id === sectionId);
    if (!section) continue;
    for (const text of splitTextIntoSlides(section.text, options)) {
      occurrences.push({
        id: newId(),
        sourceSectionId: section.id,
        label: section.label,
        text,
        order: occurrences.length,
        durationMs: null,
        visualKind: text.trim() === '' ? 'instrumental' : 'lyrics',
        visualOverrides: null,
      });
    }
  }
  return occurrences;
}
