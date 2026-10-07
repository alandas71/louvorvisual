import { createArrangement, createSong, deriveCues, type Arrangement, type Asset, type AudioBinding, type AudioPolicy, type AuthoringContext, type Song } from '@louvorvisual/domain';
import { prepareSnapshot, type SessionSnapshot } from './snapshot';

export function testContext(): AuthoringContext {
  let next = 0;
  return { workspaceId: 'ws-1', userId: 'user-1', now: '2026-10-05T12:00:00.000Z', newId: () => `id-${++next}` };
}

/**
 * Louvor de teste com um slide por duração informada (`null` = sem tempo).
 * Texto original escrito para os testes deste projeto.
 */
export function timedSong(durations: readonly (number | null)[], change: (arrangement: Arrangement) => Arrangement = (item) => item): {
  song: Song;
  arrangement: Arrangement;
  snapshot: SessionSnapshot;
} {
  const context = testContext();
  const rawLyrics = durations.map((_, index) => `[Estrofe ${index + 1}]\nLinha ${index + 1} da canção\nCom gratidão e fé`).join('\n\n');
  const { song, parsed } = createSong({ title: 'Em União', artist: 'Coral da Vila', rawLyrics }, context);
  const created = createArrangement(song, parsed, context, { themeRef: { kind: 'builtin', presetId: 'grafite' } });
  const arrangement = change({
    ...created,
    occurrences: created.occurrences.map((occurrence, index) => ({ ...occurrence, durationMs: durations[index] ?? null })),
  });
  const prepared = prepareSnapshot({ id: 'snapshot-1', now: context.now, song, arrangement, songGeneration: 1, arrangementGeneration: 1 });
  if (!prepared.ok) throw new Error(`Snapshot inválido: ${prepared.issues.join(', ')}`);
  return { song, arrangement, snapshot: prepared.snapshot };
}

const TEST_SHA = 'a'.repeat(64);

/**
 * Louvor de teste com uma faixa selecionada. `trackMs` é a duração da gravação;
 * a faixa vinculada recebe os intervalos derivados dos tempos, como no editor.
 */
export function audioSong(
  durations: readonly (number | null)[],
  options: { policy: AudioPolicy; offsetMs?: number; trackMs?: number; volume?: number },
): { song: Song; arrangement: Arrangement; snapshot: SessionSnapshot; warnings: string[] } {
  const offsetMs = options.offsetMs ?? 0;
  const binding: AudioBinding = { id: 'faixa-1', assetId: 'arquivo-1', kind: 'playback', policy: options.policy, volume: options.volume ?? 0.8, offsetMs, cuesVersion: 1, cues: [] };
  const asset: Asset = {
    id: 'arquivo-1',
    workspaceId: 'ws-1',
    sha256: TEST_SHA,
    filename: 'playback.wav',
    mimeType: 'audio/wav',
    byteSize: 1000,
    audioKind: 'playback',
    durationMs: options.trackMs ?? 60_000,
    remoteState: 'local',
    storageKey: null,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    deletedAt: null,
  };
  const { song, arrangement } = timedSong(durations, (item) => {
    const cues = options.policy === 'linked' ? (deriveCues(item.occurrences, offsetMs) ?? []) : [];
    return { ...item, audioBindings: [{ ...binding, cues }], selectedAudioBindingId: binding.id };
  });
  const prepared = prepareSnapshot({ id: 'snapshot-1', now: '2026-10-05T12:00:00.000Z', song, arrangement, songGeneration: 1, arrangementGeneration: 1, audio: { binding: arrangement.audioBindings[0] as AudioBinding, asset } });
  if (!prepared.ok) throw new Error(`Snapshot inválido: ${prepared.issues.join(', ')}`);
  return { song, arrangement, snapshot: prepared.snapshot, warnings: prepared.warnings };
}
