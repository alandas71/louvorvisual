import { MAX_ASSET_BYTES, Sha256, type Asset, type AudioKind, type AudioMimeType, type IsoInstant, type Uuid } from '@louvorvisual/domain';
import type { LocalDatabase } from './db';
import { isQuotaError, validateDocument, writeDocument } from './repository';
import { assetBlobKey, type AssetBlobRow } from './schema';

export type AudioImportErrorCode = 'unsupported-type' | 'empty' | 'too-large' | 'unplayable' | 'quota' | 'storage' | 'read';

const IMPORT_ERROR_TEXT: Record<AudioImportErrorCode, string> = {
  'unsupported-type': 'Formato não aceito. Use um arquivo MP3 ou WAV.',
  empty: 'O arquivo está vazio.',
  'too-large': 'O arquivo passa do limite de 100 MiB por faixa.',
  unplayable: 'Este navegador não conseguiu ler o áudio: o arquivo pode estar corrompido ou em um formato que ele não reproduz.',
  quota: 'Não há espaço neste dispositivo para guardar o áudio. Nada foi gravado e o que já existia continua intacto.',
  storage: 'Não foi possível guardar o áudio neste dispositivo. Nada foi gravado.',
  read: 'Não foi possível ler o arquivo escolhido.',
};

/** Falha de importação: nada ficou referenciado como disponível. */
export class AudioImportError extends Error {
  constructor(
    readonly code: AudioImportErrorCode,
    options?: { cause?: unknown },
  ) {
    super(IMPORT_ERROR_TEXT[code], options);
    this.name = 'AudioImportError';
  }
}

/** Progresso real, em bytes já lidos; não há estimativa de tempo. */
export type ImportProgress = { phase: 'reading' | 'checking' | 'storing' | 'verifying'; loadedBytes: number; totalBytes: number };

/** Pede ao navegador que leia os metadados; devolve a duração em ms ou `null` se não reproduz. */
export type AudioProbe = (blob: Blob) => Promise<number | null>;

/** Espaço livre estimado em bytes, ou `null` quando o navegador não informa. */
export type FreeSpaceEstimate = () => Promise<number | null>;

/** Folga exigida além do tamanho do arquivo antes de aceitar a escrita. */
export const QUOTA_MARGIN_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, AudioMimeType> = { mp3: 'audio/mpeg', wav: 'audio/wav' };
const MIME_ALIASES: Record<string, AudioMimeType> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
};

/** Tipo aceito a partir da extensão e do tipo informado; os dois precisam concordar quando existem. */
export function declaredAudioType(filename: string, type: string): AudioMimeType | null {
  const byExtension = MIME_BY_EXTENSION[filename.split('.').pop()?.toLowerCase() ?? ''] ?? null;
  const byType = type === '' ? null : (MIME_ALIASES[type.toLowerCase().split(';')[0]?.trim() ?? ''] ?? null);
  if (!byExtension) return null;
  if (type !== '' && byType !== byExtension) return null;
  return byExtension;
}

/** Confere o começo do arquivo: RIFF/WAVE para WAV; ID3 ou sincronismo de quadro para MP3. */
export function sniffAudioType(head: Uint8Array): AudioMimeType | null {
  const text = (start: number, length: number) => String.fromCharCode(...head.subarray(start, start + length));
  if (head.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return 'audio/wav';
  if (head.length >= 3 && text(0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && ((head[1] as number) & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/**
 * SHA-256 de um blob lido em fluxo: o arquivo passa em pedaços, sem ser
 * carregado inteiro na memória. `onProgress` recebe os bytes já lidos.
 */
export async function hashBlob(blob: Blob, onProgress?: (loadedBytes: number) => void): Promise<string> {
  const hash = new Sha256();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    onProgress?.(hash.byteLength);
  }
  return hash.digestHex();
}

export type ImportAudioInput = {
  file: Blob;
  filename: string;
  kind: AudioKind;
  profileId: Uuid;
  workspaceId: Uuid;
  now: () => IsoInstant;
  newId: () => Uuid;
  probe: AudioProbe;
  freeSpace?: FreeSpaceEstimate;
  onProgress?: (progress: ImportProgress) => void;
};

export type ImportedAudio = { asset: Asset; reusedBytes: boolean };

/**
 * Importa um arquivo de áudio para o dispositivo. Ordem (planejamento/06 e 08):
 * validar tipo, tamanho e leitura de metadados; calcular o hash em fluxo;
 * escrever os bytes em área de preparação; reler e conferir tamanho e hash; só
 * então publicar bytes e metadados juntos, em uma transação. Qualquer falha
 * antes disso não deixa nada referenciado como disponível.
 */
export async function importAudioFile(db: LocalDatabase, input: ImportAudioInput): Promise<ImportedAudio> {
  const { file, filename, workspaceId } = input;
  const totalBytes = file.size;
  const report = (phase: ImportProgress['phase'], loadedBytes: number) => input.onProgress?.({ phase, loadedBytes, totalBytes });

  const declared = declaredAudioType(filename, file.type);
  if (!declared) throw new AudioImportError('unsupported-type');
  if (totalBytes === 0) throw new AudioImportError('empty');
  if (totalBytes > MAX_ASSET_BYTES) throw new AudioImportError('too-large');

  let sha256: string;
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (sniffAudioType(head) !== declared) throw new AudioImportError('unsupported-type');
    report('reading', 0);
    sha256 = await hashBlob(file, (loaded) => report('reading', loaded));
  } catch (error) {
    if (error instanceof AudioImportError) throw error;
    throw new AudioImportError('read', { cause: error });
  }

  report('checking', totalBytes);
  const durationMs = await input.probe(file).catch(() => null);
  if (durationMs === null || !(durationMs > 0)) throw new AudioImportError('unplayable');

  const key = assetBlobKey(workspaceId, sha256);
  const existing = await db.assetBlobs.get(key);
  // Só reaproveita bytes já guardados se eles ainda conferem com o hash: reimportar
  // é justamente o caminho para consertar um arquivo que se corrompeu no dispositivo.
  const reusedBytes =
    existing?.state === 'ready' &&
    existing.byteSize === totalBytes &&
    existing.blob.size === totalBytes &&
    (await hashBlob(existing.blob, (loaded) => report('verifying', loaded)).catch(() => null)) === sha256;

  if (!reusedBytes) {
    const free = (await input.freeSpace?.().catch(() => null)) ?? null;
    if (free !== null && free < totalBytes + QUOTA_MARGIN_BYTES) throw new AudioImportError('quota');
    report('storing', 0);
    const staged: AssetBlobRow = { key, profileId: input.profileId, workspaceId, sha256, byteSize: totalBytes, mimeType: declared, blob: file, state: 'staged', storedAt: input.now(), verifiedAt: null };
    try {
      await db.assetBlobs.put(staged);
      // Confere o que ficou gravado, não o que foi entregue para gravar.
      const written = await db.assetBlobs.get(key);
      const intact = written !== undefined && written.blob.size === totalBytes && (await hashBlob(written.blob, (loaded) => report('verifying', loaded))) === sha256;
      if (!intact) throw new AudioImportError('storage');
    } catch (error) {
      await db.assetBlobs.delete(key).catch(() => undefined);
      if (error instanceof AudioImportError) throw error;
      throw new AudioImportError(isQuotaError(error) ? 'quota' : 'storage', { cause: error });
    }
  }

  const now = input.now();
  try {
    const asset = await db.transaction('rw', db.assets, db.assetBlobs, db.entityStates, async () => {
      const same = await db.assets.where('[workspaceId+sha256]').equals([workspaceId, sha256]).toArray();
      const known = same.find((item) => item.audioKind === input.kind && item.deletedAt === null);
      const document: Asset = known ?? {
        id: input.newId(),
        workspaceId,
        sha256,
        filename,
        mimeType: declared,
        byteSize: totalBytes,
        audioKind: input.kind,
        durationMs: Math.round(durationMs),
        remoteState: 'local',
        storageKey: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      if (!known) await writeDocument(db, validateDocument({ entityType: 'asset', document }));
      await db.assetBlobs.update(key, { state: 'ready', verifiedAt: now });
      return document;
    });
    report('verifying', totalBytes);
    return { asset, reusedBytes };
  } catch (error) {
    if (!reusedBytes) await db.assetBlobs.delete(key).catch(() => undefined);
    throw new AudioImportError(isQuotaError(error) ? 'quota' : 'storage', { cause: error });
  }
}

export type AssetCheck = 'ok' | 'missing' | 'corrupted';

/** Os bytes de um arquivo, só se estiverem publicados como prontos. */
export async function readAssetBlob(db: LocalDatabase, workspaceId: Uuid, sha256: string): Promise<Blob | null> {
  const row = await db.assetBlobs.get(assetBlobKey(workspaceId, sha256));
  return row?.state === 'ready' ? row.blob : null;
}

/**
 * Integridade completa: os bytes existem, têm o tamanho registrado e o hash
 * da identidade do arquivo. Lê em fluxo. Só o resultado `ok` grava a data da
 * verificação.
 */
export async function verifyAsset(
  db: LocalDatabase,
  asset: Pick<Asset, 'workspaceId' | 'sha256' | 'byteSize'>,
  now: IsoInstant,
  onProgress?: (loadedBytes: number) => void,
): Promise<AssetCheck> {
  const blob = await readAssetBlob(db, asset.workspaceId, asset.sha256);
  if (!blob) return 'missing';
  if (blob.size !== asset.byteSize) return 'corrupted';
  let sha256: string;
  try {
    sha256 = await hashBlob(blob, onProgress);
  } catch {
    return 'corrupted';
  }
  if (sha256 !== asset.sha256) return 'corrupted';
  await db.assetBlobs.update(assetBlobKey(asset.workspaceId, asset.sha256), { verifiedAt: now });
  return 'ok';
}

/** Conferência barata, sem reler os bytes: existe e tem o tamanho registrado. */
export async function assetPresent(db: LocalDatabase, asset: Pick<Asset, 'workspaceId' | 'sha256' | 'byteSize'>): Promise<boolean> {
  const blob = await readAssetBlob(db, asset.workspaceId, asset.sha256);
  return blob !== null && blob.size === asset.byteSize;
}

export async function getAsset(db: LocalDatabase, assetId: Uuid): Promise<Asset | null> {
  const asset = await db.assets.get(assetId);
  return asset && asset.deletedAt === null ? asset : null;
}

export type AudioUsage = { files: number; bytes: number; unusedFiles: number; unusedBytes: number };

/** Hashes ainda referenciados: por arranjo não excluído, por sessão ativa ou por repertório preparado. */
async function referencedHashes(db: LocalDatabase, workspaceId: Uuid): Promise<Set<string>> {
  const assets = new Map((await db.assets.where('workspaceId').equals(workspaceId).toArray()).map((asset) => [asset.id, asset]));
  const hashes = new Set<string>();
  const arrangements = await db.arrangements.where('workspaceId').equals(workspaceId).toArray();
  for (const arrangement of arrangements) {
    if (arrangement.deletedAt !== null) continue;
    for (const binding of arrangement.audioBindings) {
      const asset = assets.get(binding.assetId);
      if (asset) hashes.add(asset.sha256);
    }
  }
  for (const session of await db.presentationSessions.toArray()) {
    if (session.workspaceId === workspaceId && session.status === 'active' && session.snapshot.audio) hashes.add(session.snapshot.audio.sha256);
  }
  for (const row of await db.offlinePackages.toArray()) {
    if (row.workspaceId !== workspaceId) continue;
    for (const item of row.ready?.items ?? []) if (item.audio) hashes.add(item.audio.sha256);
  }
  return hashes;
}

async function blobSizes(db: LocalDatabase, workspaceId: Uuid): Promise<{ key: string; sha256: string; byteSize: number }[]> {
  const rows: { key: string; sha256: string; byteSize: number }[] = [];
  await db.assetBlobs.where('workspaceId').equals(workspaceId).each((row) => {
    rows.push({ key: row.key, sha256: row.sha256, byteSize: row.byteSize });
  });
  return rows;
}

export async function audioUsage(db: LocalDatabase, workspaceId: Uuid): Promise<AudioUsage> {
  const [rows, used] = await Promise.all([blobSizes(db, workspaceId), referencedHashes(db, workspaceId)]);
  const unused = rows.filter((row) => !used.has(row.sha256));
  const sum = (items: typeof rows) => items.reduce((total, row) => total + row.byteSize, 0);
  return { files: rows.length, bytes: sum(rows), unusedFiles: unused.length, unusedBytes: sum(unused) };
}

/**
 * Remove só bytes que nenhum arranjo, sessão ativa ou repertório preparado
 * usa. Não é "excluir da biblioteca": metadados e documentos não são tocados,
 * e arquivo ainda referenciado nunca é removido.
 */
export async function removeUnusedAudio(db: LocalDatabase, workspaceId: Uuid): Promise<number> {
  return db.transaction('rw', [db.assetBlobs, db.assets, db.arrangements, db.presentationSessions, db.offlinePackages], async () => {
    const [rows, used] = await Promise.all([blobSizes(db, workspaceId), referencedHashes(db, workspaceId)]);
    const unused = rows.filter((row) => !used.has(row.sha256));
    await db.assetBlobs.bulkDelete(unused.map((row) => row.key));
    return unused.length;
  });
}
