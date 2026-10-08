import { THEME_PRESETS, themePreset } from '@louvorvisual/domain';
import { describe, expect, it } from 'vitest';
import { measureSlideFit, nextRotation, REFERENCE_SIZE, ROTATIONS, slideModel, wrappedLineCount, type TextMeasurer } from './renderer';

const style = themePreset('grafite').style;
/** Medidor previsível: cada caractere ocupa metade do tamanho da fonte. */
const measure: TextMeasurer = (text, font) => text.length * font.sizePx * 0.5;

describe('slideModel', () => {
  it('usa o par de cores do tema e a família embutida com reserva explícita', () => {
    for (const preset of THEME_PRESETS) {
      const model = slideModel({ text: 'Glória', style: preset.style, fontId: preset.initialFontId });
      expect(model.viewport.backgroundColor).toBe(preset.style.palette.backgroundColor);
      expect(model.composition.color).toBe(preset.style.palette.textColor);
      expect(String(model.content.fontFamily)).toMatch(/^".+", system-ui, sans-serif$/);
      expect(model.content.fontSynthesis).toBe('none');
    }
  });

  it('dimensiona pela composição de referência nas duas proporções', () => {
    const wide = slideModel({ text: 'a', style, fontId: 'inter' });
    expect(wide.composition.aspectRatio).toBe('1920 / 1080');
    expect(wide.content.fontSize).toBe('5cqw');
    const classic = slideModel({ text: 'a', style: { ...style, aspectRatio: '4:3' }, fontId: 'inter' });
    expect(classic.composition.aspectRatio).toBe('1440 / 1080');
    // 96 px em 1440 de largura: a letra mantém a mesma altura relativa.
    expect(classic.content.fontSize).toBe(`${(96 / 1440) * 100}cqw`);
    expect(REFERENCE_SIZE['4:3'].height).toBe(REFERENCE_SIZE['16:9'].height);
  });

  it('alterna a composição entre paisagem e retrato e recalcula a escala para caber inteira', () => {
    expect(ROTATIONS.map((rotation) => slideModel({ text: 'a', style, fontId: 'inter', rotation }).composition.transform)).toEqual([
      'translate(-50%, -50%) rotate(0deg)',
      'translate(-50%, -50%) rotate(90deg)',
    ]);
    // De lado, a largura da composição passa a caber na altura da saída.
    expect(slideModel({ text: 'a', style, fontId: 'inter', rotation: 90 }).composition.width).toBe('min(100cqh, calc(100cqw * 1920 / 1080))');
    expect([0, 90].map((rotation) => nextRotation(rotation as 0 | 90))).toEqual([90, 0]);
  });

  it('tela preta cobre o tema; ocultar letra mantém o fundo; nos dois o texto não sai', () => {
    const black = slideModel({ text: 'Letra', style, fontId: 'inter', visualMode: 'black' });
    expect(black).toMatchObject({ displayText: '', viewport: { backgroundColor: '#000000' }, composition: { backgroundColor: '#000000' } });
    const hidden = slideModel({ text: 'Letra', style, fontId: 'inter', visualMode: 'lyricsHidden' });
    expect(hidden).toMatchObject({ displayText: '', viewport: { backgroundColor: '#111827' }, text: { visibility: 'hidden' } });
    expect(slideModel({ text: 'Letra', style, fontId: 'inter' })).toMatchObject({ displayText: 'Letra', text: { visibility: 'visible' } });
  });
});

describe('medição de texto', () => {
  it('quebra entre palavras como o navegador', () => {
    const width = (text: string) => text.length * 10;
    expect(wrappedLineCount('', 100, width)).toEqual({ lines: 1, wordTooWide: false });
    expect(wrappedLineCount('um dois', 100, width)).toEqual({ lines: 1, wordTooWide: false });
    expect(wrappedLineCount('um dois tres quatro', 100, width)).toEqual({ lines: 3, wordTooWide: false });
    expect(wrappedLineCount('um dois tres', 120, width)).toEqual({ lines: 1, wordTooWide: false });
    expect(wrappedLineCount('inconstitucionalissimamente', 100, width)).toEqual({ lines: 1, wordTooWide: true });
  });

  it('conta linhas visuais e avisa excesso sem cortar', () => {
    // Área útil no Grafite: 1612,8 × 907,2 px; 96 px × 1,2 → cabem 7 linhas.
    const short = measureSlideFit({ text: 'Com esperança\nvou caminhar', style, fontId: 'inter' }, measure);
    expect(short).toMatchObject({ linesPerTextLine: [1, 1], visualLines: 2, capacity: 7, overflows: false, exceedsSuggested: false });

    // 48 px por caractere: 33 caracteres por linha visual.
    const long = measureSlideFit({ text: 'Uma linha bem comprida que não cabe de jeito nenhum na largura\ncurta', style, fontId: 'inter' }, measure);
    expect(long.linesPerTextLine).toEqual([2, 1]);

    const five = measureSlideFit({ text: 'a\nb\nc\nd\ne', style, fontId: 'inter' }, measure);
    expect(five).toMatchObject({ visualLines: 5, overflows: false, exceedsSuggested: true });
  });

  it('aumentar a letra reduz a capacidade até cortar', () => {
    const text = 'a\nb\nc\nd';
    expect(measureSlideFit({ text, style: { ...style, fontSizePx: 160 }, fontId: 'inter' }, measure)).toMatchObject({ capacity: 4, overflows: false });
    expect(measureSlideFit({ text, style: { ...style, fontSizePx: 160, lineHeight: 2 }, fontId: 'inter' }, measure)).toMatchObject({ capacity: 2, overflows: true });
  });

  it('o tema de segurança, com letra maior, passa pela mesma checagem', () => {
    const safety = themePreset('preto-acessivel').style;
    expect(measureSlideFit({ text: 'a\nb\nc\nd\ne\nf\ng', style: safety, fontId: 'atkinson-hyperlegible' }, measure)).toMatchObject({ capacity: 6, overflows: true });
  });
});
