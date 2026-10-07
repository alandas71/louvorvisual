import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from './catalog';
import { parseLyrics } from './lyrics';
import { generateOccurrences, maxLinesForStyle, splitTextIntoSlides } from './slides';
import { sequentialIds } from './testing';

const lines = (count: number) => Array.from({ length: count }, (_, index) => `linha ${index + 1}`).join('\n');

describe('splitTextIntoSlides', () => {
  it('mantém até quatro linhas em um slide', () => {
    expect(splitTextIntoSlides(lines(4))).toEqual([lines(4)]);
  });

  it('equilibra os grupos em vez de deixar sobra pequena', () => {
    expect(splitTextIntoSlides(lines(5)).map((slide) => slide.split('\n').length)).toEqual([3, 2]);
    expect(splitTextIntoSlides(lines(6)).map((slide) => slide.split('\n').length)).toEqual([3, 3]);
    expect(splitTextIntoSlides(lines(9)).map((slide) => slide.split('\n').length)).toEqual([3, 3, 3]);
  });

  it.each([1, 2, 5, 7, 13, 40])('não perde nem altera texto com %i linhas', (count) => {
    const text = lines(count);
    expect(splitTextIntoSlides(text).join('\n')).toBe(text);
    expect(splitTextIntoSlides(text, { maxLines: 2 }).join('\n')).toBe(text);
  });

  it('conta as linhas visuais informadas pelo medidor', () => {
    const text = 'curta\numa linha muito longa que ocupa três linhas na tela\ncurta\ncurta';
    const visualLines = (line: string) => (line.length > 20 ? 3 : 1);
    expect(splitTextIntoSlides(text, { visualLines })).toEqual([
      'curta\numa linha muito longa que ocupa três linhas na tela',
      'curta\ncurta',
    ]);
  });

  it('linha que sozinha excede o limite fica em slide próprio, sem corte', () => {
    expect(splitTextIntoSlides('a\nenorme\nb', { visualLines: (line) => (line === 'enorme' ? 9 : 1) })).toEqual(['a', 'enorme', 'b']);
  });

  it('texto vazio gera um slide vazio', () => {
    expect(splitTextIntoSlides('')).toEqual(['']);
  });
});

describe('maxLinesForStyle', () => {
  it('nunca passa de quatro e diminui com letras maiores', () => {
    for (const preset of THEME_PRESETS) expect(maxLinesForStyle(preset.style)).toBe(4);
    const style = THEME_PRESETS[0]!.style;
    expect(maxLinesForStyle({ ...style, fontSizePx: 160, lineHeight: 2 })).toBe(2);
  });
});

describe('generateOccurrences', () => {
  const parsed = parseLyrics('[Estrofe 1]\na\nb\nc\nd\ne\n\n[Refrão]\nr1\nr2\n\n[Instrumental]\n\n[Refrão]\nr1\nr2', sequentialIds('s'));
  const occurrences = generateOccurrences(parsed, sequentialIds('o'));

  it('segue a ordem da letra e divide seções longas', () => {
    expect(occurrences.map(({ label, text, order }) => ({ label, text, order }))).toEqual([
      { label: 'Estrofe 1', text: 'a\nb\nc', order: 0 },
      { label: 'Estrofe 1', text: 'd\ne', order: 1 },
      { label: 'Refrão', text: 'r1\nr2', order: 2 },
      { label: 'Instrumental', text: '', order: 3 },
      { label: 'Refrão', text: 'r1\nr2', order: 4 },
    ]);
  });

  it('repetições têm IDs distintos e a mesma seção de origem', () => {
    const [first, second] = occurrences.filter((occurrence) => occurrence.label === 'Refrão');
    expect(first?.id).not.toBe(second?.id);
    expect(first?.sourceSectionId).toBe(second?.sourceSectionId);
    expect(new Set(occurrences.map((occurrence) => occurrence.id)).size).toBe(occurrences.length);
  });

  it('todas começam sem temporizador: null, nunca zero', () => {
    expect(occurrences.map((occurrence) => occurrence.durationMs)).toEqual([null, null, null, null, null]);
  });

  it('slide sem letra é instrumental', () => {
    expect(occurrences.map((occurrence) => occurrence.visualKind)).toEqual(['lyrics', 'lyrics', 'lyrics', 'instrumental', 'lyrics']);
  });
});
