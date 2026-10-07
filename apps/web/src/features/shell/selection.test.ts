import { describe, expect, it } from 'vitest';
import { readVisualSelection } from './selection';

const read = (query: string) => readVisualSelection(new URLSearchParams(query));

describe('readVisualSelection', () => {
  it('sem query usa Grafite com sua fonte inicial e o peso do tema', () => {
    expect(read('')).toMatchObject({ preset: { presetId: 'grafite' }, fontId: 'inter', fontChosen: false, fontWeight: 700 });
  });

  it('trocar o tema troca a fonte inicial quando nenhuma foi escolhida', () => {
    expect(read('tema=violeta')).toMatchObject({ preset: { presetId: 'violeta' }, fontId: 'montserrat', fontChosen: false });
  });

  it('a fonte escolhida manualmente permanece ao trocar o tema', () => {
    expect(read('tema=vinho&fonte=lato&peso=400')).toMatchObject({ preset: { presetId: 'vinho' }, fontId: 'lato', fontChosen: true, fontWeight: 400 });
  });

  it('valores desconhecidos caem no padrão', () => {
    expect(read('tema=claro&fonte=comic&peso=500')).toMatchObject({ preset: { presetId: 'grafite' }, fontId: 'inter', fontChosen: false, fontWeight: 700 });
  });
});
