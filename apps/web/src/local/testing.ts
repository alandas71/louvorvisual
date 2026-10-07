import { createArrangement, createSong, type AuthoringContext } from '@louvorvisual/domain';
import { LocalDatabase } from './db';

let counter = 0;

/** Banco isolado por teste, sobre fake-indexeddb. */
export function testDatabase(): LocalDatabase {
  counter += 1;
  return new LocalDatabase(`lv-test-${process.pid}-${Date.now()}-${counter}`);
}

export function testContext(now = '2026-10-05T12:00:00.000Z'): AuthoringContext {
  return {
    workspaceId: '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d',
    userId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    now,
    newId: () => crypto.randomUUID(),
  };
}

// Letra original escrita para os testes deste projeto.
export const SAMPLE_LYRICS = `[Estrofe 1]
Com esperança eu vou caminhar
E com minha voz agradecer

[Refrão]
Hoje cantamos em união
Com alegria no coração

[Refrão]
Hoje cantamos em união
Com alegria no coração`;

export function sampleSong(context: AuthoringContext = testContext(), title = 'Em União') {
  const { song, parsed } = createSong({ title, artist: 'Coral da Vila', rawLyrics: SAMPLE_LYRICS }, context);
  const arrangement = createArrangement(song, parsed, context, { themeRef: { kind: 'builtin', presetId: 'grafite' } });
  return { song, arrangement };
}
