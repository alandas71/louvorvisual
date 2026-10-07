import type { Arrangement, Asset, IsoInstant, Song, Theme, Uuid } from '@louvorvisual/domain';
import {
  buildPackage,
  openPackage,
  PackageError,
  planImport,
  type BuiltPackage,
  type ImportLookup,
  type ImportPlan,
  type MediaPolicy,
  type OpenedPackage,
  type OpenOptions,
  type PackageDocument,
  type PackageDocuments,
  type PackageEntityType,
} from '@louvorvisual/pack';
import type { Table } from 'dexie';
import { hashBlob, QUOTA_MARGIN_BYTES, readAssetBlob, type FreeSpaceEstimate } from './assets';
import type { LocalDatabase } from './db';
import { isQuotaError, LocalSaveError, validateDocument, writeDocument } from './repository';
import { assetBlobKey, type AssetBlobRow, type ImportMapRow, type LocalDocument } from './schema';

/** Versão do aplicativo web gravada no manifesto, só como informação de origem. */
export const PACKAGE_GENERATOR = { app: 'louvorvisual-web', version: '0.1.0' } as const;

function tableOf(db: LocalDatabase, entityType: PackageEntityType): Table<PackageDocument, string> {
  const tables = { song: db.songs, arrangement: db.arrangements, setlist: db.setlists, asset: db.assets, theme: db.themes };
  return tables[entityType] as unknown as Table<PackageDocument, string>;
}

/**
 * Reúne o repertório e tudo o que ele alcança: arranjos, louvores, temas da
 * equipe e os documentos dos arquivos de áudio. Um item cujo louvor saiu da
 * biblioteca impede a exportação, em vez de produzir um pacote que não abre.
 */
export async function collectSetlistDocuments(db: LocalDatabase, setlistId: Uuid): Promise<PackageDocuments> {
  const setlist = await db.setlists.get(setlistId);
  if (!setlist || setlist.deletedAt !== null) throw new PackageError('incomplete', 'O repertório não existe mais neste dispositivo.');
  const arrangements = new Map<Uuid, Arrangement>();
  const songs = new Map<Uuid, Song>();
  const assets = new Map<Uuid, Asset>();
  const themes = new Map<Uuid, Theme>();
  const missing: string[] = [];
  const includeTheme = async (ref: Arrangement['themeRef'] | null, owner: string) => {
    if (ref?.kind !== 'workspace' || themes.has(ref.themeId)) return;
    const theme = await db.themes.get(ref.themeId);
    if (theme && theme.deletedAt === null) themes.set(theme.id, theme);
    else missing.push(`o tema usado por ${owner}`);
  };

  await includeTheme(setlist.themeRef, 'este repertório');
  for (const item of setlist.items) {
    if (arrangements.has(item.arrangementId)) continue;
    const arrangement = await db.arrangements.get(item.arrangementId);
    const song = arrangement && arrangement.deletedAt === null ? await db.songs.get(arrangement.songId) : undefined;
    if (!arrangement || arrangement.deletedAt !== null || !song || song.deletedAt !== null) {
      missing.push(`o louvor do item ${item.order + 1}`);
      continue;
    }
    arrangements.set(arrangement.id, arrangement);
    songs.set(song.id, song);
    await includeTheme(arrangement.themeRef, `"${song.title}"`);
    for (const binding of arrangement.audioBindings) {
      if (assets.has(binding.assetId)) continue;
      const asset = await db.assets.get(binding.assetId);
      if (asset && asset.deletedAt === null) assets.set(asset.id, asset);
      else missing.push(`uma faixa de áudio de "${song.title}"`);
    }
  }
  if (missing.length > 0) {
    throw new PackageError('incomplete', `Não dá para exportar: falta ${[...new Set(missing)].join(', ')}. Remova o item do repertório ou corrija o louvor e tente de novo.`, missing);
  }
  return { setlist, arrangements: [...arrangements.values()], songs: [...songs.values()], assets: [...assets.values()], themes: [...themes.values()] };
}

export type PackageEstimate = { documents: number; mediaBytes: Record<MediaPolicy, number> };

/** Tamanho aproximado do pacote por política de mídia, sem ler nenhum byte de áudio. */
export async function estimateSetlistPackage(db: LocalDatabase, setlistId: Uuid): Promise<PackageEstimate> {
  const documents = await collectSetlistDocuments(db, setlistId);
  const selected = new Set<Uuid>();
  for (const arrangement of documents.arrangements) {
    const binding = arrangement.audioBindings.find((item) => item.id === arrangement.selectedAudioBindingId);
    if (binding) selected.add(binding.assetId);
  }
  const bytes = (filter: (asset: Asset) => boolean) => [...new Map(documents.assets.filter(filter).map((asset) => [asset.sha256, asset.byteSize])).values()].reduce((total, size) => total + size, 0);
  return {
    documents: 1 + documents.arrangements.length + documents.songs.length + documents.assets.length + documents.themes.length,
    mediaBytes: { all: bytes(() => true), selected: bytes((asset) => selected.has(asset.id)), none: 0 },
  };
}

export type ExportOptions = {
  mediaPolicy: MediaPolicy;
  profileKind: 'personal' | 'team';
  now: IsoInstant;
  newId: () => Uuid;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
};

/** Exporta um repertório como pacote `.louvorvisual.zip`. Só lê o banco; nada local é alterado. */
export async function exportSetlistPackage(db: LocalDatabase, setlistId: Uuid, options: ExportOptions): Promise<BuiltPackage> {
  const documents = await collectSetlistDocuments(db, setlistId);
  return buildPackage({
    documents,
    readMedia: (asset) => readAssetBlob(db, asset.workspaceId, asset.sha256),
    mediaPolicy: options.mediaPolicy,
    profileKind: options.profileKind,
    generator: PACKAGE_GENERATOR,
    now: options.now,
    newId: options.newId,
    onProgress: options.onProgress,
  });
}

export type ImportContext = { workspaceId: Uuid; userId: Uuid; profileId: Uuid; now: IsoInstant; newId: () => Uuid };

function lookupFor(db: LocalDatabase, workspaceId: Uuid): ImportLookup {
  return {
    get: async (entityType, id) => (await tableOf(db, entityType).get(id)) ?? null,
    findAsset: async (sha256, audioKind) => (await db.assets.where('[workspaceId+sha256]').equals([workspaceId, sha256]).toArray()).find((asset) => asset.audioKind === audioKind && asset.deletedAt === null) ?? null,
    mapped: async (key) => (await db.importMap.get(key))?.localId ?? null,
  };
}

const target = (db: LocalDatabase, context: ImportContext) => ({ workspaceId: context.workspaceId, userId: context.userId, now: context.now, newId: context.newId, lookup: lookupFor(db, context.workspaceId) });

export type ImportPreview = { opened: OpenedPackage; plan: ImportPlan; /** Bytes de áudio que ainda não estão neste dispositivo. */ newMediaBytes: number };

async function blobIntact(db: LocalDatabase, workspaceId: Uuid, item: { sha256: string; byteSize: number }, verify: boolean): Promise<boolean> {
  const row = await db.assetBlobs.get(assetBlobKey(workspaceId, item.sha256));
  if (!row || row.state !== 'ready' || row.blob.size !== item.byteSize) return false;
  return !verify || (await hashBlob(row.blob).catch(() => null)) === item.sha256;
}

/**
 * Abre o pacote em área de preparação — estrutura, versões, caminhos, hashes,
 * esquemas e referências conferidos — e calcula o que a importação faria.
 * Nada é gravado: é o que a tela mostra antes da confirmação.
 */
export async function previewImport(db: LocalDatabase, file: Blob, context: ImportContext, options: OpenOptions = {}): Promise<ImportPreview> {
  const opened = await openPackage(file, options);
  const plan = await planImport(opened, target(db, context));
  let newMediaBytes = 0;
  for (const item of plan.media) if (!(await blobIntact(db, context.workspaceId, item, false))) newMediaBytes += item.byteSize;
  return { opened, plan, newMediaBytes };
}

export type ImportFailureCode = 'quota' | 'storage' | 'invalid-document';

const FAILURE_TEXT: Record<ImportFailureCode, string> = {
  quota: 'Não há espaço neste dispositivo para o pacote. Nada foi importado e a biblioteca continua como estava.',
  storage: 'Não foi possível gravar o pacote neste dispositivo. Nada foi importado e a biblioteca continua como estava.',
  'invalid-document': 'Um documento do pacote não pôde ser gravado. Nada foi importado.',
};

/** Importação que não aconteceu: tudo ou nada. */
export class ImportFailure extends Error {
  constructor(
    readonly code: ImportFailureCode,
    options?: { cause?: unknown },
  ) {
    super(FAILURE_TEXT[code], options);
    this.name = 'ImportFailure';
  }
}

export type ImportResult = { setlistId: Uuid; plan: ImportPlan; mediaStored: number; mediaReused: number };

/**
 * Aplica a importação de um pacote já conferido. Ordem (planejamento/08):
 * conferir o espaço; gravar os bytes novos em área de preparação e reler cada
 * um; só então, em uma única transação, refazer o plano, publicar bytes,
 * documentos, pendências e o mapa da importação. O plano é decidido dentro da
 * transação de gravação: um documento que chegue enquanto os bytes são
 * preparados (sincronização, outra janela) já é visto como existente e nunca
 * é substituído. Qualquer falha desfaz o que foi escrito.
 */
export async function applyImport(db: LocalDatabase, opened: OpenedPackage, context: ImportContext, options: { freeSpace?: FreeSpaceEstimate } = {}): Promise<ImportResult> {
  const { workspaceId } = context;
  const media = [...opened.media.values()];

  // Bytes já presentes só são reaproveitados se ainda conferem com o hash: importar também conserta arquivo corrompido.
  const toStore: ImportPlan['media'] = [];
  for (const item of media) if (!(await blobIntact(db, workspaceId, item, true))) toStore.push(item);
  const needed = toStore.reduce((total, item) => total + item.byteSize, 0);
  const free = (await options.freeSpace?.().catch(() => null)) ?? null;
  if (needed > 0 && free !== null && free < needed + QUOTA_MARGIN_BYTES) throw new ImportFailure('quota');

  const staged: string[] = [];
  const replaced: AssetBlobRow[] = [];
  try {
    for (const item of toStore) {
      const key = assetBlobKey(workspaceId, item.sha256);
      const previous = await db.assetBlobs.get(key);
      if (previous) replaced.push(previous);
      staged.push(key);
      await db.assetBlobs.put({ key, profileId: context.profileId, workspaceId, sha256: item.sha256, byteSize: item.byteSize, mimeType: item.mimeType, blob: item.blob, state: 'staged', storedAt: context.now, verifiedAt: null });
      // Confere o que ficou gravado, não o que foi entregue para gravar.
      const written = await db.assetBlobs.get(key);
      if (!written || written.blob.size !== item.byteSize || (await hashBlob(written.blob)) !== item.sha256) throw new ImportFailure('storage');
    }

    const plan = await db.transaction('rw', [db.songs, db.songIndex, db.arrangements, db.setlists, db.assets, db.themes, db.entityStates, db.assetBlobs, db.importMap], async () => {
      const plan = await planImport(opened, target(db, context));
      const writes = plan.writes.map((write) => validateDocument(write as LocalDocument));
      for (const write of writes) await writeDocument(db, write);
      for (const key of staged) await db.assetBlobs.update(key, { state: 'ready', verifiedAt: context.now });
      const rows: ImportMapRow[] = plan.mappings.map((mapping) => ({ ...mapping, packageId: opened.manifest.packageId, importedAt: context.now }));
      await db.importMap.bulkPut(rows);
      return plan;
    });
    return { setlistId: plan.setlistId, plan, mediaStored: toStore.length, mediaReused: media.length - toStore.length };
  } catch (error) {
    // Desfaz a área de preparação; o que existia antes (mesmo corrompido) volta a ser o que era.
    await db.assetBlobs.bulkDelete(staged).catch(() => undefined);
    await db.assetBlobs.bulkPut(replaced).catch(() => undefined);
    if (error instanceof ImportFailure) throw error;
    if (error instanceof LocalSaveError && error.code !== 'quota' && error.code !== 'storage') throw new ImportFailure('invalid-document', { cause: error });
    throw new ImportFailure(isQuotaError(error) ? 'quota' : 'storage', { cause: error });
  }
}
