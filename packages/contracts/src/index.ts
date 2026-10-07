import { arrangementSchema } from './arrangement';
import { assetSchema } from './asset';
import { setlistSchema } from './setlist';
import { songSchema } from './song';
import { themeSchema } from './theme';

export * from './common';
export * from './song';
export * from './theme';
export * from './arrangement';
export * from './setlist';
export * from './asset';
export * from './sync';
export * from './fontPack';
export * from './bridge';
export type { DocumentsMatchDomain } from './conformance';

/** Esquema por tipo de entidade, com os nomes usados nos envelopes de sincronização. */
export const documentSchemas = {
  song: songSchema,
  arrangement: arrangementSchema,
  theme: themeSchema,
  setlist: setlistSchema,
  asset: assetSchema,
} as const;

export type EntityType = keyof typeof documentSchemas;
