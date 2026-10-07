import { describe, expect, it } from 'vitest';
import { parseLyrics, parseMarker } from './lyrics';
import { sequentialIds } from './testing';
import { normalizeForSearch, normalizeLyrics } from './text';

// Letras originais escritas para os testes deste projeto.
const EXEMPLO = `[Estrofe 1]
Com esperança eu vou caminhar
E com minha voz agradecer

[Refrão]
Hoje cantamos em união
Com alegria no coração

[Refrão]
Hoje cantamos em união
Com alegria no coração`;

function parse(lyrics: string) {
  return parseLyrics(lyrics, sequentialIds('s'));
}

describe('normalizeLyrics', () => {
  it('uniformiza finais de linha, remove espaços finais e compõe acentos', () => {
    expect(normalizeLyrics('Coração  \r\nfé\t\rfim')).toBe('Coração\nfé\nfim');
  });

  it('a chave de busca ignora acentos e caixa', () => {
    expect(normalizeForSearch('  Canção   de GRATIDÃO ')).toBe('cancao de gratidao');
  });
});

describe('parseMarker', () => {
  it('reconhece a lista conhecida, com número e contagem', () => {
    expect(parseMarker('[Estrofe 1]')).toEqual({ kind: 'verse', label: 'Estrofe 1', repeat: 1 });
    expect(parseMarker('  [REFRÃO]  ')).toEqual({ kind: 'chorus', label: 'Refrão', repeat: 1 });
    expect(parseMarker('[Refrão 2x]')).toEqual({ kind: 'chorus', label: 'Refrão', repeat: 2 });
    expect(parseMarker('[Ponte]')?.kind).toBe('bridge');
    expect(parseMarker('[Introdução]')?.kind).toBe('intro');
    expect(parseMarker('[Instrumental]')?.kind).toBe('instrumental');
  });

  it('não interpreta marcador desconhecido nem colchetes no meio da linha', () => {
    expect(parseMarker('[Aleluia]')).toBeNull();
    expect(parseMarker('Canta [bis] outra vez')).toBeNull();
    expect(parseMarker('[Refrão] agora')).toBeNull();
    expect(parseMarker('[Refrão 99x]')).toBeNull();
  });
});

describe('parseLyrics', () => {
  it('exemplo do planejamento: duas seções e três aparições na ordem da letra', () => {
    const { sections, sequence, warnings } = parse(EXEMPLO);
    expect(sections.map(({ kind, label, detection, order }) => ({ kind, label, detection, order }))).toEqual([
      { kind: 'verse', label: 'Estrofe 1', detection: 'explicit', order: 0 },
      { kind: 'chorus', label: 'Refrão', detection: 'explicit', order: 1 },
    ]);
    expect(sections[0]?.text).toBe('Com esperança eu vou caminhar\nE com minha voz agradecer');
    expect(sequence).toEqual(['s-1', 's-2', 's-2']);
    expect(warnings).toEqual([]);
  });

  it('bloco sem marcador vira "Trecho N" de tipo desconhecido, com aviso', () => {
    const { sections, warnings } = parse('Primeira linha\nSegunda linha\n\nOutra parte');
    expect(sections.map(({ kind, label, detection }) => ({ kind, label, detection }))).toEqual([
      { kind: 'unknown', label: 'Trecho 1', detection: 'suggested' },
      { kind: 'unknown', label: 'Trecho 2', detection: 'suggested' },
    ]);
    expect(warnings.map((warning) => warning.code)).toEqual(['unlabeled-block', 'unlabeled-block']);
  });

  it('letra sem linhas vazias é um único bloco', () => {
    const { sections, sequence } = parse('um\ndois\ntrês\nquatro\ncinco');
    expect(sections).toHaveLength(1);
    expect(sequence).toHaveLength(1);
    expect(sections[0]?.text).toBe('um\ndois\ntrês\nquatro\ncinco');
  });

  it('bloco sem marcador repetido é sugerido como repetição, sem afirmar que é refrão', () => {
    const { sections, sequence, warnings } = parse('Cantai\nLouvai\n\nNo meio\n\nCantai\nLouvai');
    expect(sections).toHaveLength(2);
    expect(sequence).toEqual(['s-1', 's-2', 's-1']);
    expect(sections[0]?.kind).toBe('unknown');
    expect(warnings.map((warning) => warning.code)).toContain('repeated-block');
  });

  it('blocos com uma linha diferente continuam distintos e visíveis', () => {
    const { sections, sequence, warnings } = parse('[Refrão]\nHoje cantamos\nCom alegria\n\n[Refrão]\nHoje cantamos\nCom gratidão');
    expect(sections.map((section) => section.text)).toEqual(['Hoje cantamos\nCom alegria', 'Hoje cantamos\nCom gratidão']);
    expect(sequence).toEqual(['s-1', 's-2']);
    expect(warnings.map((warning) => warning.code)).toEqual(['same-label-different-text']);
  });

  it('diferença só de pontuação ou acento não é fundida: avisa e mantém os dois textos', () => {
    const { sections, warnings } = parse('[Refrão]\nGlória, glória!\n\n[Refrão]\nGloria gloria');
    expect(sections.map((section) => section.text)).toEqual(['Glória, glória!', 'Gloria gloria']);
    expect(warnings.map((warning) => warning.code)).toEqual(['similar-block']);
  });

  it('marcador desconhecido e colchetes no meio permanecem como texto', () => {
    const { sections, warnings } = parse('[Aleluia]\nCanta [bis] outra vez');
    expect(sections[0]?.text).toBe('[Aleluia]\nCanta [bis] outra vez');
    expect(warnings.map((warning) => [warning.code, warning.line])).toEqual([
      ['unlabeled-block', 1],
      ['unknown-marker', 1],
    ]);
  });

  it('"Refrão 2x" sugere duas aparições e deixa a decisão visível', () => {
    const { sequence, warnings } = parse('[Refrão 2x]\nSanto, santo');
    expect(sequence).toEqual(['s-1', 's-1']);
    expect(warnings.map((warning) => warning.code)).toEqual(['repeat-count']);
  });

  it('[Refrão] sem texto repete o refrão anterior, com aviso', () => {
    const { sections, sequence, warnings } = parse('[Refrão]\nSanto, santo\n\n[Estrofe 1]\nNova manhã\n\n[Refrão]');
    expect(sections).toHaveLength(2);
    expect(sequence).toEqual(['s-1', 's-2', 's-1']);
    expect(warnings.map((warning) => warning.code)).toEqual(['empty-marker-repeat']);
  });

  it('instrumental vazio vira seção sem texto', () => {
    const { sections, sequence } = parse('[Introdução]\n\n[Estrofe 1]\nNova manhã\n\n[Instrumental]\n\n[Instrumental]');
    expect(sections.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'intro', text: '' },
      { kind: 'verse', text: 'Nova manhã' },
      { kind: 'instrumental', text: '' },
    ]);
    expect(sequence).toEqual(['s-1', 's-2', 's-3', 's-3']);
  });

  it('marcador sem linha vazia antes também inicia um bloco', () => {
    const { sections } = parse('[Estrofe 1]\nNova manhã\n[Refrão]\nSanto, santo');
    expect(sections.map((section) => section.label)).toEqual(['Estrofe 1', 'Refrão']);
  });

  it('preserva acentos, pontuação e linhas; aceita CRLF', () => {
    const { sections } = parse('[Estrofe 1]\r\nÓ, quão bom é — louvar!\r\n"Aleluia", cantarão…\r\n');
    expect(sections[0]?.text).toBe('Ó, quão bom é — louvar!\n"Aleluia", cantarão…');
  });

  it('todo o texto da letra aparece em alguma seção', () => {
    const lyrics = Array.from({ length: 300 }, (_, index) => (index % 5 === 4 ? '' : `Linha número ${index} com ação`)).join('\n');
    const { sections, sequence } = parse(lyrics);
    const rebuilt = sequence.map((id) => sections.find((section) => section.id === id)?.text).join('\n');
    expect(rebuilt.split('\n')).toEqual(lyrics.split('\n').filter((line) => line !== ''));
  });

  it('letra vazia não gera seções', () => {
    expect(parse('  \n\n')).toEqual({ sections: [], sequence: [], warnings: [] });
  });
});
