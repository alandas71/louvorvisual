import type { Arrangement, Asset, Setlist, Song, Theme } from '@louvorvisual/domain';

// Documentos originais de teste; a letra foi escrita para este projeto.
const workspaceId = '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d';
const userId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const now = '2026-10-05T12:00:00.000Z';

const meta = {
  workspaceId,
  schemaVersion: 1,
  serverRevision: null,
  createdBy: userId,
  updatedBy: userId,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
} as const;

export const verseId = '11111111-1111-4111-8111-111111111111';
export const chorusId = '22222222-2222-4222-8222-222222222222';

export const song: Song = {
  ...meta,
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Manhã de Gratidão',
  artist: null,
  authors: [],
  musicalKey: 'G',
  tags: ['exemplo'],
  notes: '',
  rawLyrics: '[Estrofe 1]\nA luz chegou sobre a cidade\n\n[Refrão]\nCantamos juntos, gratidão',
  sections: [
    { id: verseId, kind: 'verse', label: 'Estrofe 1', text: 'A luz chegou sobre a cidade', order: 0, detection: 'explicit' },
    { id: chorusId, kind: 'chorus', label: 'Refrão', text: 'Cantamos juntos, gratidão', order: 1, detection: 'explicit' },
  ],
};

export const asset: Asset = {
  id: '44444444-4444-4444-8444-444444444444',
  workspaceId,
  sha256: 'a'.repeat(64),
  filename: 'manha-de-gratidao-playback.mp3',
  mimeType: 'audio/mpeg',
  byteSize: 3_500_000,
  audioKind: 'playback',
  durationMs: 9000,
  remoteState: 'local',
  storageKey: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const o1 = '55555555-5555-4555-8555-555555555551';
const o2 = '55555555-5555-4555-8555-555555555552';
const o3 = '55555555-5555-4555-8555-555555555553';
const bindingId = '66666666-6666-4666-8666-666666666666';

export const arrangement: Arrangement = {
  ...meta,
  id: '77777777-7777-4777-8777-777777777777',
  songId: song.id,
  name: 'Culto',
  basedOnSongRevision: null,
  themeRef: { kind: 'builtin', presetId: 'grafite' },
  themeOverrides: { fontSizePx: 96 },
  fontId: null,
  fontPackVersion: '1',
  occurrences: [
    { id: o1, sourceSectionId: verseId, label: 'Estrofe 1', text: 'A luz chegou sobre a cidade', order: 0, durationMs: 4000, visualKind: 'lyrics', visualOverrides: null },
    { id: o2, sourceSectionId: chorusId, label: 'Refrão', text: 'Cantamos juntos, gratidão', order: 1, durationMs: 3000, visualKind: 'lyrics', visualOverrides: null },
    { id: o3, sourceSectionId: chorusId, label: 'Refrão', text: 'Cantamos juntos, gratidão', order: 2, durationMs: 2000, visualKind: 'lyrics', visualOverrides: { fontWeight: 700 } },
  ],
  audioBindings: [
    {
      id: bindingId,
      assetId: asset.id,
      kind: 'playback',
      policy: 'linked',
      volume: 0.8,
      offsetMs: 0,
      cuesVersion: 1,
      cues: [
        { occurrenceId: o1, startMs: 0, endMs: 4000 },
        { occurrenceId: o2, startMs: 4000, endMs: 7000 },
        { occurrenceId: o3, startMs: 7000, endMs: 9000 },
      ],
    },
  ],
  selectedAudioBindingId: bindingId,
  defaultMode: 'automatic',
};

export const theme: Theme = {
  ...meta,
  id: '88888888-8888-4888-8888-888888888888',
  name: 'Grafite da equipe',
  basePresetId: 'grafite',
  fontId: 'inter',
  fontPackVersion: '1',
  aspectRatio: '16:9',
  palette: { backgroundColor: '#111827', textColor: '#F9FAFB' },
  fontSizePx: 88,
  fontWeight: 700,
  textAlign: 'center',
  verticalAlign: 'center',
  lineHeight: 1.2,
  margins: { horizontalPercent: 8, verticalPercent: 8 },
  shadow: 'soft',
  outline: null,
  transition: { kind: 'fade', durationMs: 150 },
  credits: { showTitle: false, showArtist: false },
};

export const setlist: Setlist = {
  ...meta,
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Culto de domingo',
  serviceDate: '2026-10-11',
  timeZone: 'America/Sao_Paulo',
  themeRef: null,
  notes: '',
  items: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', arrangementId: arrangement.id, order: 0, notes: '' },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', arrangementId: arrangement.id, order: 1, notes: 'Repetir no encerramento' },
  ],
};
