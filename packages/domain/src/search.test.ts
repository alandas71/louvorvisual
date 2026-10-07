import { describe, expect, it } from 'vitest';
import { createSong } from './authoring';
import { buildSongSearchEntry, findSimilarSongs, searchSongEntries } from './search';
import { sequentialIds } from './testing';

const context = { workspaceId: 'w', userId: 'u', now: '2026-10-05T12:00:00.000Z', newId: sequentialIds() };
const entry = (title: string, artist: string | null, rawLyrics: string, tags: string[] = []) =>
  buildSongSearchEntry(createSong({ title, artist, rawLyrics, tags }, context).song);

const entries = [
  entry('Manhã de Gratidão', 'Coral da Vila', 'A luz chegou sobre a cidade'),
  entry('Canção da Esperança', 'Grupo Manhã', 'Com esperança eu vou caminhar', ['ceia']),
  entry('Em União', null, 'Hoje cantamos em união\nNa manhã de gratidão'),
];
const titles = (query: string) => searchSongEntries(entries, query).map((item) => item.title);

describe('searchSongEntries', () => {
  it('tolera diferenças de acento e caixa', () => {
    expect(titles('cancao')).toEqual(['Canção da Esperança']);
    expect(titles('UNIAO')).toEqual(['Em União']);
  });

  it('procura em título, artista, etiquetas e letra, com o título na frente', () => {
    expect(titles('manha')).toEqual(['Manhã de Gratidão', 'Canção da Esperança', 'Em União']);
    expect(titles('ceia')).toEqual(['Canção da Esperança']);
    expect(titles('cidade')).toEqual(['Manhã de Gratidão']);
  });

  it('exige todas as palavras', () => {
    expect(titles('manha coral')).toEqual(['Manhã de Gratidão']);
    expect(titles('manha inexistente')).toEqual([]);
  });

  it('consulta vazia lista tudo em ordem alfabética', () => {
    expect(titles('  ')).toEqual(['Canção da Esperança', 'Em União', 'Manhã de Gratidão']);
  });

  it('o índice mantém o título original para exibição', () => {
    expect(entries[0]).toMatchObject({ title: 'Manhã de Gratidão', titleKey: 'manha de gratidao' });
  });

  it('responde dentro da meta com 500 louvores', () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      entry(`Louvor ${index}`, 'Artista', Array.from({ length: 40 }, (_, line) => `verso ${line} do louvor ${index} com gratidão`).join('\n')),
    );
    const started = Date.now();
    expect(searchSongEntries(many, 'louvor 499 gratidao')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('findSimilarSongs', () => {
  it('avisa sobre título igual sem acento ou pontuação, exceto o próprio registro', () => {
    expect(findSimilarSongs(entries, 'manha de gratidao!').map((item) => item.title)).toEqual(['Manhã de Gratidão']);
    expect(findSimilarSongs(entries, 'Manhã de Gratidão', entries[0]!.id)).toEqual([]);
    expect(findSimilarSongs(entries, '  ')).toEqual([]);
  });
});
