import { describe, expect, it } from 'vitest';
import { contrastRatio, relativeLuminance } from './color';
import { paletteIssues } from './theme';

describe('cores', () => {
  it('calcula luminância e contraste nos extremos', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('recusa cor fora do formato #RRGGBB', () => {
    expect(() => relativeLuminance('#fff')).toThrow(RangeError);
  });
});

describe('paletteIssues', () => {
  // Paletas de fábrica propostas em planejamento/07.
  const factoryPalettes = [
    ['#111827', '#F9FAFB'],
    ['#0B1730', '#DBEAFE'],
    ['#1B1033', '#EDE9FE'],
    ['#0B2119', '#D1FAE5'],
    ['#2A0E18', '#FFE4E6'],
    ['#211809', '#FDE68A'],
    ['#08242A', '#CCFBF1'],
    ['#000000', '#FFFFFF'],
  ] as const;

  it.each(factoryPalettes)('aceita %s com %s', (backgroundColor, textColor) => {
    expect(paletteIssues({ backgroundColor, textColor })).toEqual([]);
  });

  it('recusa fundo claro', () => {
    expect(paletteIssues({ backgroundColor: '#FFFFFF', textColor: '#000000' })).toEqual(['background-not-dark']);
  });

  it('recusa contraste insuficiente', () => {
    expect(paletteIssues({ backgroundColor: '#111827', textColor: '#4B5563' })).toEqual(['low-contrast']);
  });

  it('recusa cor inválida sem calcular contraste', () => {
    expect(paletteIssues({ backgroundColor: 'preto', textColor: '#FFFFFF' })).toEqual(['invalid-color']);
  });
});
