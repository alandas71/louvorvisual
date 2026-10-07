import { describe, expect, it } from 'vitest';
import { arrangementIssues } from './arrangement';
import { createArrangement, createSong, duplicateArrangement, duplicateSong, parseList, reparseLyrics, songInputIssues, touch } from './authoring';
import { MAX_LYRICS_CHARS } from './lyrics';
import { sequentialIds } from './testing';

const context = () => ({ workspaceId: 'w', userId: 'u', now: '2026-10-05T12:00:00.000Z', newId: sequentialIds() });

// Letra original de teste, com espaços finais, CRLF e acento decomposto de propósito.
const RAW = '[Estrofe 1]\r\nCom esperança eu vou caminhar  \r\n\r\n[Refrão]\r\nHoje cantamos em união\r\n\r\n[Refrão]\r\nHoje cantamos em união';

describe('createSong', () => {
  it('guarda a letra original byte a byte e sugere seções sobre a cópia normalizada', () => {
    const { song } = createSong({ title: '  Em União ', artist: ' ', rawLyrics: RAW }, context());
    expect(song.rawLyrics).toBe(RAW);
    expect(song.title).toBe('Em União');
    expect(song.artist).toBeNull();
    expect(song.sections.map((section) => section.text)).toEqual(['Com esperança eu vou caminhar', 'Hoje cantamos em união']);
    expect(song).toMatchObject({ workspaceId: 'w', schemaVersion: 1, serverRevision: null, deletedAt: null, createdBy: 'u' });
  });

  it('valida título e limite de letra', () => {
    expect(songInputIssues({ title: ' ', rawLyrics: '' })).toEqual(['title-required']);
    expect(songInputIssues({ title: 'a', rawLyrics: 'x'.repeat(MAX_LYRICS_CHARS + 1) })).toEqual(['lyrics-too-long']);
    expect(songInputIssues({ title: 'a', rawLyrics: '' })).toEqual([]);
  });

  it('parseList separa por vírgula, ponto e vírgula e linha', () => {
    expect(parseList('ceia, natal; ceia\n  ')).toEqual(['ceia', 'natal']);
  });
});

describe('createArrangement', () => {
  it('cria a sequência inicial válida, manual e sem tempos', () => {
    const ctx = context();
    const { song, parsed } = createSong({ title: 'Em União', rawLyrics: RAW }, ctx);
    const arrangement = createArrangement(song, parsed, ctx, { themeRef: { kind: 'builtin', presetId: 'grafite' } });
    expect(arrangement).toMatchObject({ songId: song.id, name: 'Culto', defaultMode: 'manual', fontId: null, basedOnSongRevision: null });
    expect(arrangement.occurrences.map((item) => [item.label, item.durationMs])).toEqual([
      ['Estrofe 1', null],
      ['Refrão', null],
      ['Refrão', null],
    ]);
    expect(arrangementIssues(arrangement)).toEqual([]);
  });
});

describe('duplicar', () => {
  it('arranjo duplicado não compartilha IDs e mantém marcações coerentes', () => {
    const ctx = context();
    const { song, parsed } = createSong({ title: 'Em União', rawLyrics: RAW }, ctx);
    const base = createArrangement(song, parsed, ctx, { themeRef: { kind: 'builtin', presetId: 'grafite' } });
    const [first] = base.occurrences;
    const source = {
      ...base,
      audioBindings: [
        { id: 'b', assetId: 'a', kind: 'playback' as const, policy: 'independent' as const, volume: 1, offsetMs: 0, cuesVersion: 1, cues: [{ occurrenceId: first!.id, startMs: 0, endMs: 1000 }] },
      ],
      selectedAudioBindingId: 'b',
    };
    const copy = duplicateArrangement(source, ctx, { name: 'Ensaio' });
    const ids = new Set(source.occurrences.map((item) => item.id));
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('Ensaio');
    expect(copy.occurrences.some((item) => ids.has(item.id))).toBe(false);
    expect(copy.occurrences.map((item) => item.text)).toEqual(source.occurrences.map((item) => item.text));
    expect(copy.selectedAudioBindingId).toBe(copy.audioBindings[0]?.id);
    expect(copy.audioBindings[0]?.cues[0]?.occurrenceId).toBe(copy.occurrences[0]?.id);
    expect(arrangementIssues(copy)).toEqual([]);
  });

  it('louvor duplicado leva os arranjos com seções remapeadas', () => {
    const ctx = context();
    const { song, parsed } = createSong({ title: 'Em União', rawLyrics: RAW }, ctx);
    const arrangement = createArrangement(song, parsed, ctx, { themeRef: { kind: 'builtin', presetId: 'grafite' } });
    const copy = duplicateSong(song, [arrangement], ctx, 'Em União (cópia)');
    expect(copy.song.id).not.toBe(song.id);
    expect(copy.song.rawLyrics).toBe(song.rawLyrics);
    const sectionIds = new Set(copy.song.sections.map((section) => section.id));
    expect(copy.song.sections.some((section) => song.sections.some((original) => original.id === section.id))).toBe(false);
    expect(copy.arrangements[0]?.songId).toBe(copy.song.id);
    expect(copy.arrangements[0]?.occurrences.every((item) => item.sourceSectionId !== null && sectionIds.has(item.sourceSectionId))).toBe(true);
  });
});

describe('reparseLyrics', () => {
  it('mantém ID e classificação manual das seções cujo texto não mudou', () => {
    const first = reparseLyrics('Santo, santo\n\nNova manhã', [], sequentialIds('a'));
    const reviewed = first.sections.map((section, index) =>
      index === 0 ? { ...section, kind: 'chorus' as const, label: 'Refrão', detection: 'manual' as const } : section,
    );
    const second = reparseLyrics('Santo, santo\n\nNova manhã chegou\n\nSanto, santo', reviewed, sequentialIds('b'));
    expect(second.sections.map(({ id, kind, label, detection }) => ({ id, kind, label, detection }))).toEqual([
      { id: 'a-1', kind: 'chorus', label: 'Refrão', detection: 'manual' },
      { id: 'b-2', kind: 'unknown', label: 'Trecho 2', detection: 'suggested' },
    ]);
    expect(second.sequence).toEqual(['a-1', 'b-2', 'a-1']);
    expect(second.warnings.every((warning) => ['a-1', 'b-2'].includes(warning.sectionId))).toBe(true);
  });
});

describe('touch', () => {
  it('atualiza autoria e instante sem mexer na revisão do servidor', () => {
    const { song } = createSong({ title: 'a', rawLyrics: '' }, context());
    expect(touch({ ...song, serverRevision: '7' }, { userId: 'x', now: '2026-10-06T00:00:00.000Z' })).toMatchObject({
      serverRevision: '7',
      updatedBy: 'x',
      updatedAt: '2026-10-06T00:00:00.000Z',
      createdBy: 'u',
    });
  });
});
