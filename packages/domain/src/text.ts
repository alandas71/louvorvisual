/**
 * Cópia para análise: finais de linha uniformes, espaços finais removidos e
 * Unicode composto (NFC). A letra original nunca é substituída por esta cópia.
 */
export function normalizeLyrics(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n');
}

/** Chave de busca: sem acentos, sem caixa e com espaços simples. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chave de comparação entre blocos: como a de busca, mas também sem pontuação. */
export function normalizeForComparison(text: string): string {
  return normalizeForSearch(text)
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
