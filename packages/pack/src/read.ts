import { documentSchemas } from '@louvorvisual/contracts';
import { FONT_PACK_VERSION, isBundledFontId, isThemePresetId, SCHEMA_VERSION, Sha256, type Arrangement, type Asset, type AudioMimeType, type Setlist, type Song, type Theme } from '@louvorvisual/domain';
import { fontPackVersions, referenceProblems, usedBuiltins, type PackageDocuments } from './contents';
import { PackageError } from './errors';
import {
  documentPath,
  MANIFEST_PATH,
  manifestHeaderSchema,
  manifestSchema,
  mediaPath,
  PACKAGE_LIMITS,
  PACKAGE_READER_VERSION,
  type PackageEntityType,
  type PackageLimits,
  type PackageManifest,
} from './manifest';
import { Crc32, eachChunk, readZip, type ZipEntry } from './zip';

/** O que o aplicativo de destino sabe ler e tem instalado. */
export type ReaderSupport = {
  readerVersion: number;
  schemaVersion: number;
  fontPackVersion: string;
  hasThemePreset(presetId: string): boolean;
  hasFont(fontId: string): boolean;
};

export const DEFAULT_SUPPORT: ReaderSupport = {
  readerVersion: PACKAGE_READER_VERSION,
  schemaVersion: SCHEMA_VERSION,
  fontPackVersion: FONT_PACK_VERSION,
  hasThemePreset: isThemePresetId,
  hasFont: isBundledFontId,
};

/**
 * Conversões de documentos de uma versão de esquema para a seguinte, pela
 * versão de origem. Vazio enquanto só existe a versão 1; um pacote antigo sem
 * caminho até a versão atual é recusado, nunca lido "como der".
 */
export const DOCUMENT_UPGRADES: Readonly<Record<number, (entityType: PackageEntityType, document: unknown) => unknown>> = {};

export type PackageMedia = { sha256: string; byteSize: number; mimeType: AudioMimeType; blob: Blob };

/** Pacote aberto e conferido por inteiro. Nada foi gravado no dispositivo. */
export type OpenedPackage = {
  manifest: PackageManifest;
  documents: PackageDocuments;
  /** Bytes por hash; fatias do arquivo original, já conferidas. */
  media: Map<string, PackageMedia>;
  /** Tamanho do arquivo do pacote, igual ao tamanho expandido. */
  totalBytes: number;
};

export type OpenOptions = {
  support?: Partial<ReaderSupport>;
  limits?: Partial<PackageLimits>;
  /** Bytes já conferidos e o total do pacote. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
};

async function verified(entry: ZipEntry, expected: { byteSize: number; sha256: string }, onChunk: (bytes: number) => void): Promise<void> {
  if (entry.size !== expected.byteSize) throw new PackageError('hash-mismatch', `O arquivo ${entry.path} tem tamanho diferente do registrado no manifesto.`, { path: entry.path });
  const sha = new Sha256();
  const crc = new Crc32();
  await eachChunk(entry.data, (chunk) => {
    sha.update(chunk);
    crc.update(chunk);
    onChunk(chunk.length);
  });
  if (sha.byteLength !== expected.byteSize || crc.digest() !== entry.crc32 || sha.digestHex() !== expected.sha256) {
    throw new PackageError('hash-mismatch', `O arquivo ${entry.path} não confere com o hash do manifesto: o pacote está corrompido ou foi alterado.`, { path: entry.path });
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PackageError(path === MANIFEST_PATH ? 'manifest-invalid' : 'document-invalid', `O arquivo ${path} não é um JSON válido.`, { path });
  }
}

/**
 * Abre um pacote em área de preparação: confere estrutura do ZIP, versões,
 * caminhos, tamanhos, hashes, esquemas e referências **antes** de qualquer
 * gravação. Qualquer divergência interrompe com `PackageError`.
 */
export async function openPackage(file: Blob, options: OpenOptions = {}): Promise<OpenedPackage> {
  const support: ReaderSupport = { ...DEFAULT_SUPPORT, ...options.support };
  const limits: PackageLimits = { ...PACKAGE_LIMITS, ...options.limits };
  if (file.size > limits.maxTotalBytes) throw new PackageError('too-large', 'O pacote passa do tamanho máximo aceito.');

  const zip = await readZip(file, { maxEntries: limits.maxEntries });
  const byPath = new Map(zip.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(MANIFEST_PATH);
  if (!manifestEntry) throw new PackageError('manifest-missing', 'O arquivo não tem manifesto: não é um pacote LouvorVisual.');
  if (manifestEntry.size > limits.maxManifestBytes) throw new PackageError('too-large', 'O manifesto do pacote é grande demais.');
  const manifestCrc = new Crc32();
  await eachChunk(manifestEntry.data, (chunk) => manifestCrc.update(chunk));
  if (manifestCrc.digest() !== manifestEntry.crc32) throw new PackageError('hash-mismatch', 'O manifesto do pacote está corrompido.', { path: MANIFEST_PATH });
  const raw = parseJson(await manifestEntry.data.text(), MANIFEST_PATH);

  // Primeiro só o cabeçalho: um pacote de formato mais novo é recusado com
  // esse motivo, e não por algum campo que este leitor desconhece.
  const header = manifestHeaderSchema.safeParse(raw);
  if (!header.success) throw new PackageError('manifest-invalid', 'O manifesto não identifica um pacote LouvorVisual.', header.error.issues);
  if (header.data.minReaderVersion > support.readerVersion) {
    throw new PackageError('format-too-new', 'Este pacote foi criado por uma versão mais nova do LouvorVisual. Atualize o aplicativo para importar.', {
      minReaderVersion: header.data.minReaderVersion,
      readerVersion: support.readerVersion,
    });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new PackageError('manifest-invalid', 'O manifesto do pacote está incompleto ou inválido.', parsed.error.issues);
  const manifest = parsed.data;

  if (manifest.schemaVersion > support.schemaVersion) {
    throw new PackageError('schema-too-new', 'O conteúdo deste pacote usa um formato de documento mais novo do que o deste aplicativo. Atualize o aplicativo para importar.', {
      schemaVersion: manifest.schemaVersion,
      supported: support.schemaVersion,
    });
  }
  for (let version = manifest.schemaVersion; version < support.schemaVersion; version += 1) {
    if (!DOCUMENT_UPGRADES[version]) throw new PackageError('schema-unsupported', 'Este pacote é de uma versão antiga que este aplicativo não sabe mais converter.', { schemaVersion: manifest.schemaVersion });
  }
  if (manifest.fontPackVersion !== support.fontPackVersion) {
    throw new PackageError('font-pack-incompatible', 'O pacote pede outra versão do pacote de fontes. Atualize o aplicativo antes de importar.', {
      required: manifest.fontPackVersion,
      installed: support.fontPackVersion,
    });
  }

  // Manifesto e ZIP precisam listar exatamente os mesmos arquivos.
  const listed = new Set<string>([MANIFEST_PATH]);
  for (const entry of manifest.entries) {
    const expected = entry.kind === 'document' ? documentPath(entry.entityType, entry.entityId) : mediaPath(entry.sha256);
    if (entry.path !== expected) throw new PackageError('unsafe-path', `O manifesto registra um caminho fora do padrão: ${entry.path.slice(0, 120)}`);
    if (listed.has(entry.path)) throw new PackageError('manifest-invalid', `O manifesto lista o mesmo arquivo duas vezes: ${entry.path}`);
    listed.add(entry.path);
    if (!byPath.has(entry.path)) throw new PackageError('missing-file', `Falta no pacote um arquivo listado no manifesto: ${entry.path}`, { path: entry.path });
    const limit = entry.kind === 'document' ? limits.maxDocumentBytes : limits.maxMediaBytes;
    if (entry.byteSize > limit) throw new PackageError('too-large', `O arquivo ${entry.path} passa do limite de tamanho.`, { path: entry.path });
  }
  for (const entry of zip) {
    if (!listed.has(entry.path)) throw new PackageError('unexpected-file', `O pacote contém um arquivo que o manifesto não lista: ${entry.path}`, { path: entry.path });
  }

  let loaded = 0;
  const total = manifest.entries.reduce((sum, entry) => sum + entry.byteSize, 0);
  const progress = (bytes: number) => options.onProgress?.((loaded += bytes), total);
  options.onProgress?.(0, total);

  const collected: { setlist: Setlist[]; arrangement: Arrangement[]; song: Song[]; asset: Asset[]; theme: Theme[] } = { setlist: [], arrangement: [], song: [], asset: [], theme: [] };
  const media = new Map<string, PackageMedia>();
  const mediaAssets = new Map<string, string>();
  for (const entry of manifest.entries) {
    const zipEntry = byPath.get(entry.path) as ZipEntry;
    await verified(zipEntry, entry, progress);
    if (entry.kind === 'media') {
      media.set(entry.sha256, { sha256: entry.sha256, byteSize: entry.byteSize, mimeType: entry.mimeType, blob: zipEntry.data.slice(0, zipEntry.size, entry.mimeType) });
      for (const assetId of entry.assetIds) mediaAssets.set(assetId, entry.sha256);
      continue;
    }
    let value = parseJson(await zipEntry.data.text(), entry.path);
    for (let version = manifest.schemaVersion; version < support.schemaVersion; version += 1) value = DOCUMENT_UPGRADES[version]?.(entry.entityType, value);
    const result = (documentSchemas[entry.entityType] as { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: unknown } } }).safeParse(value);
    if (!result.success) throw new PackageError('document-invalid', `O documento ${entry.path} não passa na validação.`, { path: entry.path, issues: result.error?.issues });
    const document = result.data as { id: string; workspaceId: string };
    if (document.id !== entry.entityId) throw new PackageError('document-invalid', `O documento ${entry.path} tem um ID diferente do caminho.`, { path: entry.path });
    (collected[entry.entityType] as unknown[]).push(document);
  }

  const [setlist] = collected.setlist;
  if (!setlist || collected.setlist.length !== 1 || setlist.id !== manifest.scope.setlistId) throw new PackageError('reference-broken', 'O pacote precisa conter exatamente o repertório indicado no manifesto.');
  const documents: PackageDocuments = { setlist, arrangements: collected.arrangement, songs: collected.song, assets: collected.asset, themes: collected.theme };
  if (setlist.workspaceId !== manifest.origin.workspaceId) throw new PackageError('reference-broken', 'Os documentos não pertencem ao espaço de origem declarado no manifesto.');
  const problems = referenceProblems(documents);
  if (problems.length > 0) throw new PackageError('reference-broken', 'O pacote tem referências a conteúdo que não está nele.', problems);

  // Cada arquivo de áudio tem os seus bytes no pacote ou está declarado como ausente.
  const omitted = new Map(manifest.omittedMedia.map((item) => [item.assetId, item]));
  for (const asset of documents.assets) {
    const sha256 = mediaAssets.get(asset.id);
    const item = sha256 ? media.get(sha256) : undefined;
    if (item) {
      if (omitted.has(asset.id) || item.sha256 !== asset.sha256 || item.byteSize !== asset.byteSize || item.mimeType !== asset.mimeType) {
        throw new PackageError('hash-mismatch', `Os bytes de "${asset.filename}" não correspondem ao documento do arquivo.`, { assetId: asset.id });
      }
    } else if (omitted.get(asset.id)?.sha256 !== asset.sha256) {
      throw new PackageError('missing-file', `Faltam no pacote os bytes de "${asset.filename}", e o manifesto não os declara ausentes.`, { assetId: asset.id });
    }
  }
  for (const assetId of [...mediaAssets.keys(), ...omitted.keys()]) {
    if (!documents.assets.some((asset) => asset.id === assetId)) throw new PackageError('reference-broken', 'O manifesto cita um arquivo de áudio que não está entre os documentos.', { assetId });
  }

  const packs = fontPackVersions(documents).filter((version) => version !== support.fontPackVersion);
  if (packs.length > 0) throw new PackageError('font-pack-incompatible', 'Há documentos que pedem outra versão do pacote de fontes.', packs);
  const builtin = usedBuiltins(documents);
  const missing = [...builtin.themePresetIds.filter((id) => !support.hasThemePreset(id)).map((id) => `tema ${id}`), ...builtin.fontIds.filter((id) => !support.hasFont(id)).map((id) => `fonte ${id}`)];
  if (missing.length > 0) throw new PackageError('catalog-missing', `Este aplicativo não tem um recurso de fábrica que o pacote usa: ${missing.join(', ')}.`, missing);

  return { manifest, documents, media, totalBytes: file.size };
}
