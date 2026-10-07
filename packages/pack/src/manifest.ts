import { isoInstantSchema, sha256Schema, uuidSchema } from '@louvorvisual/contracts';
import { AUDIO_MIME_TYPES, MAX_ASSET_BYTES } from '@louvorvisual/domain';
import { z } from 'zod';

/** Identificação do formato; ver packages/pack/FORMATO.md. */
export const PACKAGE_FORMAT = 'louvorvisual-package';
/** Versão do formato que este código escreve. */
export const PACKAGE_FORMAT_VERSION = 1;
/** Maior `minReaderVersion` que este código sabe ler. */
export const PACKAGE_READER_VERSION = 1;
export const PACKAGE_FILE_EXTENSION = '.louvorvisual.zip';
export const MANIFEST_PATH = 'manifest.json';

export const PACKAGE_ENTITY_TYPES = ['setlist', 'arrangement', 'song', 'asset', 'theme'] as const;
export type PackageEntityType = (typeof PACKAGE_ENTITY_TYPES)[number];

/**
 * Limites da política inicial (planejamento/08 e 17). O pacote é por
 * repertório; o teto total fica abaixo do limite de 4 GiB do contêiner.
 */
export const PACKAGE_LIMITS = {
  maxEntries: 1000,
  maxManifestBytes: 1024 * 1024,
  maxDocumentBytes: 1024 * 1024,
  maxMediaBytes: MAX_ASSET_BYTES,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
} as const;
export type PackageLimits = { [K in keyof typeof PACKAGE_LIMITS]: number };

export const documentPath = (entityType: PackageEntityType, entityId: string) => `documents/${entityType}/${entityId}.json`;
export const mediaPath = (sha256: string) => `media/${sha256}`;

/** Quais faixas entram: todas as associadas, só a escolhida de cada arranjo, ou nenhuma. */
export const MEDIA_POLICIES = ['all', 'selected', 'none'] as const;
export type MediaPolicy = (typeof MEDIA_POLICIES)[number];

const documentEntrySchema = z.object({
  kind: z.literal('document'),
  path: z.string(),
  entityType: z.enum(PACKAGE_ENTITY_TYPES),
  entityId: uuidSchema,
  byteSize: z.int().min(2),
  sha256: sha256Schema,
});

const mediaEntrySchema = z.object({
  kind: z.literal('media'),
  path: z.string(),
  sha256: sha256Schema,
  byteSize: z.int().min(1),
  mimeType: z.enum(AUDIO_MIME_TYPES),
  /** Documentos de arquivo deste pacote que usam estes bytes. */
  assetIds: z.array(uuidSchema).min(1),
});

/**
 * Cabeçalho lido antes de qualquer outra coisa, sem exigir os demais campos:
 * decide se este leitor pode continuar.
 */
export const manifestHeaderSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.int().min(1),
  minReaderVersion: z.int().min(1),
});

/**
 * Manifesto. Campos desconhecidos são ignorados (uma versão posterior pode
 * acrescentá-los sem subir `minReaderVersion`); tipos de entrada
 * desconhecidos não são aceitos.
 */
export const manifestSchema = manifestHeaderSchema.extend({
  packageId: uuidSchema,
  createdAt: isoInstantSchema,
  /** Versão de esquema de todos os documentos do pacote. */
  schemaVersion: z.int().min(1),
  /** Pacote de fontes de fábrica que os documentos referenciam; não vem no arquivo. */
  fontPackVersion: z.string().min(1),
  generator: z.object({ app: z.string().min(1).max(40), version: z.string().min(1).max(40) }),
  origin: z.object({ workspaceId: uuidSchema, profileKind: z.enum(['personal', 'team']) }),
  scope: z.object({ kind: z.literal('setlist'), setlistId: uuidSchema, title: z.string().max(500) }),
  /** Temas e fontes de fábrica usados, pelo ID do catálogo embutido. */
  builtin: z.object({ themePresetIds: z.array(z.string().min(1)), fontIds: z.array(z.string().min(1)) }),
  mediaPolicy: z.enum(MEDIA_POLICIES),
  entries: z.array(z.discriminatedUnion('kind', [documentEntrySchema, mediaEntrySchema])),
  /** Faixas referenciadas cujos bytes não vieram, e por quê. */
  omittedMedia: z.array(
    z.object({
      assetId: uuidSchema,
      sha256: sha256Schema,
      byteSize: z.int().min(1),
      reason: z.enum(['not-selected', 'policy-none', 'unavailable']),
    }),
  ),
});

export type PackageManifest = z.infer<typeof manifestSchema>;
export type ManifestEntry = PackageManifest['entries'][number];
export type OmittedMedia = PackageManifest['omittedMedia'][number];
