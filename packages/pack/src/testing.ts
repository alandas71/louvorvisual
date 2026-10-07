import { Sha256, type Arrangement, type Asset, type Setlist, type Song, type Theme } from '@louvorvisual/domain';
import { arrangement, asset, setlist, song, theme } from '../../contracts/src/fixtures';
import { buildPackage, type PackageSource } from './build';
import type { PackageDocument, PackageDocuments } from './contents';
import { MANIFEST_PATH, type PackageEntityType, type PackageManifest } from './manifest';
import type { ImportLookup, ImportPlan } from './plan';
import { Crc32, readZip, writeZip } from './zip';

export const ORIGIN_WORKSPACE = song.workspaceId;
export const OTHER_WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const IMPORTER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const NOW = '2026-10-06T12:00:00.000Z';

export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

/** Bytes de "áudio" de teste: determinísticos, sem ser um arquivo de áudio de verdade. */
export function mediaBytes(size = 4096, seed = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}

export type Sample = { documents: PackageDocuments; media: Map<string, Blob>; playback: Asset; original: Asset };

/**
 * Repertório de teste: um louvor, um arranjo com duas faixas (playback
 * escolhido e original extra), um tema da equipe e dois itens.
 */
export function sample(): Sample {
  const playbackBytes = mediaBytes(4096, 7);
  const originalBytes = mediaBytes(2048, 99);
  const playback: Asset = { ...asset, sha256: sha256Hex(playbackBytes), byteSize: playbackBytes.length, remoteState: 'ready', storageKey: 'espaco/segredo-do-servidor' };
  const original: Asset = { ...asset, id: '44444444-4444-4444-8444-444444444445', sha256: sha256Hex(originalBytes), byteSize: originalBytes.length, audioKind: 'original', filename: 'original.mp3' };
  const withAudio: Arrangement = {
    ...arrangement,
    themeRef: { kind: 'workspace', themeId: theme.id },
    audioBindings: [
      { ...arrangement.audioBindings[0]!, assetId: playback.id },
      { id: '66666666-6666-4666-8666-666666666667', assetId: original.id, kind: 'original', policy: 'independent', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] },
    ],
  };
  return {
    documents: { setlist: structuredClone(setlist), arrangements: [withAudio], songs: [structuredClone(song)], assets: [playback, original], themes: [structuredClone(theme)] },
    media: new Map([
      [playback.sha256, new Blob([playbackBytes], { type: 'audio/mpeg' })],
      [original.sha256, new Blob([originalBytes], { type: 'audio/mpeg' })],
    ]),
    playback,
    original,
  };
}

let counter = 0;
/** UUIDs previsíveis e válidos para os testes. */
export function nextId(): string {
  counter += 1;
  return `dddddddd-dddd-4ddd-8ddd-${String(counter).padStart(12, '0')}`;
}

export function source(input: Sample, overrides: Partial<PackageSource> = {}): PackageSource {
  return {
    documents: input.documents,
    readMedia: async (item) => input.media.get(item.sha256) ?? null,
    mediaPolicy: 'all',
    profileKind: 'personal',
    generator: { app: 'teste', version: '0.0.0' },
    now: NOW,
    newId: nextId,
    ...overrides,
  };
}

export async function build(input: Sample = sample(), overrides: Partial<PackageSource> = {}) {
  return buildPackage(source(input, overrides));
}

const encoder = new TextEncoder();

async function crcOf(blob: Blob): Promise<number> {
  return new Crc32().update(new Uint8Array(await blob.arrayBuffer())).digest();
}

/**
 * Reescreve um pacote como um adulterador faria. `files` troca, acrescenta
 * (valor novo) ou remove (`null`) arquivos; `manifest` altera o manifesto. Com
 * `fixHashes`, tamanhos e hashes do manifesto são recalculados para os bytes
 * novos — o caso de quem adultera com cuidado. CRCs do ZIP ficam sempre certos.
 */
export async function repack(
  file: Blob,
  changes: { files?: Record<string, Uint8Array<ArrayBuffer> | string | null>; manifest?: (manifest: PackageManifest & Record<string, unknown>) => void; fixHashes?: boolean },
): Promise<Blob> {
  const entries = new Map((await readZip(file, { maxEntries: 10_000 })).map((entry) => [entry.path, entry.data as Blob]));
  for (const [path, value] of Object.entries(changes.files ?? {})) {
    if (value === null) entries.delete(path);
    else entries.set(path, new Blob([typeof value === 'string' ? encoder.encode(value) : value]));
  }
  const manifest = JSON.parse(await (entries.get(MANIFEST_PATH) as Blob).text()) as PackageManifest & Record<string, unknown>;
  if (changes.fixHashes) {
    for (const entry of manifest.entries) {
      const blob = entries.get(entry.path);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      entry.byteSize = bytes.length;
      if (entry.kind === 'document') entry.sha256 = sha256Hex(bytes);
    }
  }
  changes.manifest?.(manifest);
  entries.set(MANIFEST_PATH, new Blob([encoder.encode(JSON.stringify(manifest))]));
  return writeZip(await Promise.all([...entries].map(async ([path, data]) => ({ path, data, crc32: await crcOf(data) }))));
}

/** Biblioteca de destino em memória, com as mesmas consultas do adaptador real. */
export class MemoryLibrary implements ImportLookup {
  readonly documents = new Map<string, PackageDocument>();
  readonly mappings = new Map<string, string>();
  readonly blobs = new Map<string, Blob>();

  put(entityType: PackageEntityType, document: PackageDocument): void {
    this.documents.set(`${entityType}:${document.id}`, structuredClone(document));
  }

  find<T extends PackageDocument = Song | Arrangement | Setlist | Theme | Asset>(entityType: PackageEntityType, id: string): T | undefined {
    return this.documents.get(`${entityType}:${id}`) as T | undefined;
  }

  list<T extends PackageDocument>(entityType: PackageEntityType): T[] {
    return [...this.documents].filter(([key]) => key.startsWith(`${entityType}:`)).map(([, document]) => document as T);
  }

  async get(entityType: PackageEntityType, id: string) {
    return this.documents.get(`${entityType}:${id}`) ?? null;
  }

  async findAsset(sha256: string, audioKind: Asset['audioKind']) {
    return this.list<Asset>('asset').find((item) => item.sha256 === sha256 && item.audioKind === audioKind && item.deletedAt === null) ?? null;
  }

  async mapped(key: string) {
    return this.mappings.get(key) ?? null;
  }

  /** Aplica um plano como o adaptador faria: documentos, bytes e mapeamentos. */
  apply(plan: ImportPlan): void {
    for (const write of plan.writes) this.put(write.entityType, write.document);
    for (const item of plan.media) this.blobs.set(item.sha256, item.blob);
    for (const mapping of plan.mappings) this.mappings.set(mapping.key, mapping.localId);
  }
}
