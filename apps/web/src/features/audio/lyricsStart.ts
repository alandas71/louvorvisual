/** Palavra reconhecida na faixa, com o instante (ms, no arquivo) em que começa. */
export type TimedWord = { text: string; startMs: number };

const STORAGE_PREFIX = 'lv:first-voice:v2:';
/** Um trecho só conta como a letra se tiver palavras seguidas suficientes para não ser coincidência. */
const MIN_RUN_WORDS = 2;
const MIN_RUN_LETTERS = 10;
/** Ao recuar do trecho reconhecido até o começo da letra: só por palavras cantadas em sequência. */
const MAX_BACKTRACK_WORDS = 6;
const MAX_BACKTRACK_GAP_MS = 2000;

/** Palavras comparáveis: minúsculas, sem acento e sem pontuação. */
export function lyricsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const PORTUGUESE = new Set(['que', 'de', 'do', 'da', 'em', 'meu', 'teu', 'com', 'nao', 'para', 'por', 'senhor', 'os', 'as', 'um', 'uma', 'eu', 'tu', 'ao', 'se']);
const ENGLISH = new Set(['the', 'and', 'you', 'your', 'my', 'of', 'to', 'in', 'is', 'lord', 'we', 'our', 'with', 'for', 'all', 'i', 'will', 'are', 'on', 'be']);

/** Idioma em que a faixa é transcrita: o da letra. Na dúvida, português. */
export function lyricsLanguage(lyrics: string): 'portuguese' | 'english' {
  let balance = 0;
  for (const token of lyricsTokens(lyrics)) balance += (ENGLISH.has(token) ? 1 : 0) - (PORTUGUESE.has(token) ? 1 : 0);
  return balance > 0 ? 'english' : 'portuguese';
}

/** Chave do resultado guardado: muda com o arquivo e com a letra. */
export function firstVoiceStorageKey(sha256: string, lyrics: string): string {
  let hash = 5381;
  for (const token of lyricsTokens(lyrics)) for (let i = 0; i < token.length; i++) hash = ((hash * 33) ^ token.charCodeAt(i)) >>> 0;
  return `${STORAGE_PREFIX}${sha256}:${hash.toString(36)}`;
}

/**
 * Instante em que a letra do louvor começa a ser cantada, a partir das palavras
 * reconhecidas na faixa. O reconhecimento inventa texto em trechos só
 * instrumentais; por isso vale apenas o primeiro trecho que repete palavras
 * seguidas da letra. Achado o trecho no meio de um verso, recua até o começo
 * dele enquanto as palavras anteriores vierem coladas.
 */
export function findLyricsStart(words: readonly TimedWord[], lyrics: string): number | null {
  const sung = lyricsTokens(lyrics);
  const heard = words.flatMap((word) => lyricsTokens(word.text).map((token) => ({ token, startMs: word.startMs })));
  for (let i = 0; i < heard.length; i++) {
    for (let j = 0; j < sung.length; j++) {
      let run = 0;
      let letters = 0;
      while (i + run < heard.length && j + run < sung.length && (heard[i + run] as { token: string }).token === sung[j + run]) {
        letters += (sung[j + run] as string).length;
        run += 1;
      }
      if (run < MIN_RUN_WORDS || letters < MIN_RUN_LETTERS) continue;
      // O trecho pode ter caído no meio do verso: as palavras logo antes já eram canto.
      let start = i;
      for (let back = 0; back < Math.min(j, MAX_BACKTRACK_WORDS) && start > 0; back++) {
        const previous = heard[start - 1] as { startMs: number };
        if ((heard[start] as { startMs: number }).startMs - previous.startMs > MAX_BACKTRACK_GAP_MS) break;
        start -= 1;
      }
      return (heard[start] as { startMs: number }).startMs;
    }
  }
  return null;
}
