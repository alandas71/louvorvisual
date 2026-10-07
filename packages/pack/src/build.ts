import { documentSchemas } from '@louvorvisual/contracts';
import { FONT_PACK_VERSION, SCHEMA_VERSION, Sha256, type Asset, type IsoInstant, type Uuid } from '@louvorvisual/domain';
import { allDocuments, fontPackVersions, referenceProblems, usedBuiltins, type PackageDocument, type PackageDocuments } from './contents';
import { PackageError } from './errors';
import {
  documentPath,
  MANIFEST_PATH,
  mediaPath,
  PACKAGE_FILE_EXTENSION,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  PACKAGE_LIMITS,
  PACKAGE_READER_VERSION,
  type ManifestEntry,
  type MediaPolicy,
  type OmittedMedia,
  type PackageEntityType,
  type PackageManifest,
} from './manifest';
import { Crc32, eachChunk, writeZip, type ZipInput } from './zip';

export type PackageSource = {
  documents: PackageDocuments;
  /** Bytes locais de um arquivo, ou `null` quando não estão neste dispositivo. */
  readMedia(asset: Asset): Promise<Blob | null>;
  mediaPolicy: MediaPolicy;
  profileKind: 'personal' | 'team';
  generator: { app: string; version: string };
  now: IsoInstant;
  newId: () => Uuid;
  /** Bytes de mídia já lidos e o total previsto. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
};

export type BuiltPackage = { file: Blob; filename: string; manifest: PackageManifest };

const encoder = new TextEncoder();

async function digests(blob: Blob, onChunk?: (bytes: number) => void): Promise<{ sha256: string; crc32: number }> {
  const sha = new Sha256();
  const crc = new Crc32();
  await eachChunk(blob, (chunk) => {
    sha.update(chunk);
    crc.update(chunk);
    onChunk?.(chunk.length);
  });
  return { sha256: sha.digestHex(), crc32: crc.digest() };
}

/**
 * O que sai do dispositivo é só conteúdo autoral. O documento passa pelo
 * esquema estrito (campo desconhecido é erro, não é copiado) e os campos de
 * controle do servidor de arquivos são zerados.
 */
function exportable(entityType: PackageEntityType, document: PackageDocument): PackageDocument {
  const candidate = entityType === 'asset' ? { ...(document as Asset), remoteState: 'local', storageKey: null } : document;
  const result = (documentSchemas[entityType] as { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues: unknown } } }).safeParse(candidate);
  if (!result.success) throw new PackageError('document-invalid', `O ${entityType} ${document.id} não passa na validação e não pode ser exportado.`, result.error?.issues);
  return result.data as PackageDocument;
}

/** Nome de arquivo previsível: `repertorio-<título>-<data>.louvorvisual.zip`. */
export function packageFilename(title: string, now: IsoInstant): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `repertorio-${slug || 'sem-titulo'}-${now.slice(0, 10).replaceAll('-', '')}${PACKAGE_FILE_EXTENSION}`;
}

/**
 * Monta o pacote de um repertório. Cada faixa é lida uma vez, em fluxo, para
 * calcular SHA-256 e CRC; os bytes entram no arquivo por referência. Faixa
 * ausente ou diferente do hash registrado não entra e fica declarada em
 * `omittedMedia` — o pacote nunca afirma conter o que não contém.
 */
export async function buildPackage(source: PackageSource): Promise<BuiltPackage> {
  const { documents } = source;
  const problems = referenceProblems(documents);
  if (problems.length > 0) throw new PackageError('incomplete', 'O repertório tem referências que não podem ser empacotadas.', problems);
  const packs = fontPackVersions(documents).filter((version) => version !== FONT_PACK_VERSION);
  if (packs.length > 0) throw new PackageError('font-pack-incompatible', 'Há documentos que pedem outra versão do pacote de fontes.', packs);

  const files: ZipInput[] = [];
  const entries: ManifestEntry[] = [];
  for (const { entityType, document } of allDocuments(documents)) {
    const bytes = encoder.encode(JSON.stringify(exportable(entityType, document)));
    if (bytes.length > PACKAGE_LIMITS.maxDocumentBytes) throw new PackageError('too-large', `O ${entityType} ${document.id} passa do limite de tamanho por documento.`);
    const blob = new Blob([bytes], { type: 'application/json' });
    const { sha256, crc32 } = await digests(blob);
    const path = documentPath(entityType, document.id);
    files.push({ path, data: blob, crc32 });
    entries.push({ kind: 'document', path, entityType, entityId: document.id, byteSize: bytes.length, sha256 });
  }

  // Faixa escolhida de cada arranjo; as demais são extras.
  const selected = new Set<string>();
  for (const arrangement of documents.arrangements) {
    const binding = arrangement.audioBindings.find((item) => item.id === arrangement.selectedAudioBindingId);
    if (binding) selected.add(binding.assetId);
  }
  const wanted = (asset: Asset) => source.mediaPolicy === 'all' || (source.mediaPolicy === 'selected' && selected.has(asset.id));
  const totalBytes = documents.assets.filter(wanted).reduce((total, asset) => total + asset.byteSize, 0);
  let loadedBytes = 0;
  source.onProgress?.(0, totalBytes);

  const omittedMedia: OmittedMedia[] = [];
  const media = new Map<string, Extract<ManifestEntry, { kind: 'media' }>>();
  for (const asset of documents.assets) {
    const omit = (reason: OmittedMedia['reason']) => omittedMedia.push({ assetId: asset.id, sha256: asset.sha256, byteSize: asset.byteSize, reason });
    if (!wanted(asset)) {
      omit(source.mediaPolicy === 'none' ? 'policy-none' : 'not-selected');
      continue;
    }
    const known = media.get(asset.sha256);
    if (known) {
      known.assetIds.push(asset.id);
      continue;
    }
    const blob = await source.readMedia(asset);
    if (!blob || blob.size !== asset.byteSize) {
      omit('unavailable');
      continue;
    }
    const { sha256, crc32 } = await digests(blob, (bytes) => source.onProgress?.((loadedBytes += bytes), totalBytes));
    if (sha256 !== asset.sha256) {
      omit('unavailable');
      continue;
    }
    const path = mediaPath(sha256);
    files.push({ path, data: blob, crc32 });
    const entry = { kind: 'media' as const, path, sha256, byteSize: blob.size, mimeType: asset.mimeType, assetIds: [asset.id] };
    media.set(sha256, entry);
    entries.push(entry);
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    minReaderVersion: PACKAGE_READER_VERSION,
    packageId: source.newId(),
    createdAt: source.now,
    schemaVersion: SCHEMA_VERSION,
    fontPackVersion: FONT_PACK_VERSION,
    generator: source.generator,
    origin: { workspaceId: documents.setlist.workspaceId, profileKind: source.profileKind },
    scope: { kind: 'setlist', setlistId: documents.setlist.id, title: documents.setlist.title },
    builtin: usedBuiltins(documents),
    mediaPolicy: source.mediaPolicy,
    entries,
    omittedMedia,
  };
  const manifestBlob = new Blob([encoder.encode(JSON.stringify(manifest, null, 2))], { type: 'application/json' });
  if (manifestBlob.size > PACKAGE_LIMITS.maxManifestBytes) throw new PackageError('too-large', 'O manifesto do pacote ficou grande demais.');
  const file = writeZip([{ path: MANIFEST_PATH, data: manifestBlob, crc32: (await digests(manifestBlob)).crc32 }, ...files]);
  if (file.size > PACKAGE_LIMITS.maxTotalBytes) throw new PackageError('too-large', 'O pacote passa do limite de 2 GiB. Exporte sem áudio ou só com a faixa escolhida de cada louvor.');
  return { file, filename: packageFilename(documents.setlist.title, source.now), manifest };
}
