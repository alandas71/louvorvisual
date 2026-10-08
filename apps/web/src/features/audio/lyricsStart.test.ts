import { describe, expect, it } from 'vitest';
import { findLyricsStart, firstVoiceStorageKey, lyricsLanguage, lyricsTokens, type TimedWord } from './lyricsStart';

const LYRICS = 'Com esperança eu vou caminhar\nE com minha voz agradecer\n\nHoje cantamos em união\nCom alegria no coração';

const words = (...items: [number, string][]): TimedWord[] => items.map(([startMs, text]) => ({ startMs, text }));

describe('lyricsTokens', () => {
  it('ignora acentos, caixa e pontuação', () => {
    expect(lyricsTokens('Com esperança, EU vou!')).toEqual(['com', 'esperanca', 'eu', 'vou']);
  });
});

describe('findLyricsStart', () => {
  it('acha o começo da letra depois de uma introdução instrumental', () => {
    const heard = words([12_000, ' Com'], [12_400, ' esperança'], [13_100, ' eu'], [13_300, ' vou'], [13_600, ' caminhar.']);
    expect(findLyricsStart(heard, LYRICS)).toBe(12_000);
  });

  it('descarta o texto inventado pelo reconhecimento na introdução', () => {
    const heard = words([500, ' Música'], [3000, ' O'], [3200, ' que'], [3300, ' é'], [3400, ' isso?'], [20_000, ' Com'], [20_500, ' esperança'], [21_000, ' eu'], [21_200, ' vou']);
    expect(findLyricsStart(heard, LYRICS)).toBe(20_000);
  });

  it('recua até o começo do verso quando só o fim dele foi reconhecido', () => {
    const heard = words([15_000, ' Tom'], [15_400, ' esperanto'], [16_200, ' eu'], [16_400, ' vou'], [16_700, ' caminhar']);
    // "eu vou caminhar" é o trecho que confere; as palavras coladas antes dele já eram canto.
    expect(findLyricsStart(heard, LYRICS)).toBe(15_000);
  });

  it('não recua por cima de um silêncio longo', () => {
    const heard = words([2000, ' Obrigado.'], [15_000, ' esperança'], [15_600, ' eu'], [15_800, ' vou'], [16_100, ' caminhar']);
    expect(findLyricsStart(heard, LYRICS)).toBe(15_000);
  });

  it('uma coincidência curta não conta como a letra', () => {
    expect(findLyricsStart(words([1000, ' E'], [1200, ' com'], [9000, ' tchau']), LYRICS)).toBeNull();
    expect(findLyricsStart(words([1000, ' Obrigado'], [1500, ' por'], [1800, ' assistir']), LYRICS)).toBeNull();
  });
});

describe('lyricsLanguage', () => {
  it('segue o idioma da letra e fica em português na dúvida', () => {
    expect(lyricsLanguage(LYRICS)).toBe('portuguese');
    expect(lyricsLanguage('Join us now and share the software, you will be free')).toBe('english');
    expect(lyricsLanguage('')).toBe('portuguese');
  });
});

describe('firstVoiceStorageKey', () => {
  it('muda com o arquivo e com a letra, não com a pontuação', () => {
    const key = firstVoiceStorageKey('abc', LYRICS);
    expect(firstVoiceStorageKey('abc', LYRICS.toUpperCase().replace(/\n/g, ' , '))).toBe(key);
    expect(firstVoiceStorageKey('abd', LYRICS)).not.toBe(key);
    expect(firstVoiceStorageKey('abc', `${LYRICS} amém`)).not.toBe(key);
  });
});
