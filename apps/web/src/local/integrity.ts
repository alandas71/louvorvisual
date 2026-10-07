import { documentSchemas } from '@louvorvisual/contracts';
import { buildSongSearchEntry, type Arrangement, type Asset, type IsoInstant, type Song, type Uuid } from '@louvorvisual/domain';
import type { Table } from 'dexie';
import { hashBlob } from './assets';
import type { LocalDatabase } from './db';
import { RecoveryError } from './history';
import { assetBlobKey, entityStateKey, type LocalRevision } from './schema';

type DocType = 'song' | 'arrangement' | 'setlist' | 'asset' | 'theme';
const DOC_TYPES: readonly DocType[] = ['song', 'arrangement', 'setlist', 'asset', 'theme'];

type Raw = Record<string, unknown> & { id: string };

function tableOf(db: LocalDatabase, entityType: DocType): Table<Raw, string> {
  const tables = { song: db.songs, arrangement: db.arrangements, setlist: db.setlists, asset: db.assets, theme: db.themes };
  return tables[entityType] as unknown as Table<Raw, string>;
}

const valid = (entityType: DocType, value: unknown): boolean => (documentSchemas[entityType] as { safeParse(input: unknown): { success: boolean } }).safeParse(value).success;

function titleOf(row: Raw): string {
  for (const field of ['title', 'name', 'filename']) if (typeof row[field] === 'string' && row[field] !== '') return row[field] as string;
  return row.id;
}

export type DocumentProblem = {
  kind: 'document';
  entityType: DocType;
  entityId: Uuid;
  title: string;
  /**
   * De onde o conteúdo pode voltar: `server` — a última versão confirmada pela
   * equipe; `history` — a cópia válida mais recente do histórico local;
   * `none` — só resta retirar o registro ilegível (ele fica guardado).
   */
  repair: 'server' | 'history' | 'none';
};

export type MediaProblem = {
  kind: 'media';
  assetId: Uuid;
  filename: string;
  /** `missing`: sem bytes; `incomplete`: escrita interrompida; `corrupted`: bytes diferentes do hash. */
  issue: 'missing' | 'incomplete' | 'corrupted';
  /** `download`: a equipe tem os bytes e a sincronização baixa de novo; `reimport`: escolher o arquivo outra vez no editor. */
  repair: 'download' | 'reimport';
  songTitles: string[];
};

export type IntegrityReport = { checkedAt: IsoInstant; documents: number; mediaFiles: number; mediaVerified: boolean; problems: (DocumentProblem | MediaProblem)[] };

async function repairSource(db: LocalDatabase, entityType: DocType, entityId: Uuid): Promise<{ from: 'server' | 'history'; document: Raw } | null> {
  const state = await db.entityStates.get(entityStateKey(entityType, entityId));
  const acknowledged = state?.lastAckSnapshot && valid(entityType, state.lastAckSnapshot) ? (state.lastAckSnapshot as unknown as Raw) : null;
  // Sem alteração local pendente, o que o servidor confirmou é exatamente o que estava aqui.
  if (acknowledged && state?.dirty === 0) return { from: 'server', document: acknowledged };
  const revisions = (await db.revisions.where('[entityType+entityId]').equals([entityType, entityId]).toArray())
    .filter((revision) => revision.reason !== 'corrupted' && valid(entityType, revision.document))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (revisions[0]) return { from: 'history', document: revisions[0].document as unknown as Raw };
  return acknowledged ? { from: 'server', document: acknowledged } : null;
}

/**
 * Confere o que está gravado: cada documento contra o esquema e, para as
 * faixas usadas por arranjos ativos, a presença dos bytes — com `verifyMedia`,
 * também o SHA-256 de cada arquivo (lê tudo; pode demorar). Não altera nada.
 */
export async function scanIntegrity(db: LocalDatabase, options: { verifyMedia: boolean; now: IsoInstant; onProgress?: (done: number, total: number) => void }): Promise<IntegrityReport> {
  const problems: IntegrityReport['problems'] = [];
  let documents = 0;
  for (const entityType of DOC_TYPES) {
    for (const row of await tableOf(db, entityType).toArray()) {
      documents += 1;
      if (valid(entityType, row)) continue;
      problems.push({ kind: 'document', entityType, entityId: row.id, title: titleOf(row), repair: (await repairSource(db, entityType, row.id))?.from ?? 'none' });
    }
  }

  const broken = new Set(problems.map((problem) => (problem.kind === 'document' ? `${problem.entityType}:${problem.entityId}` : '')));
  const usedBy = new Map<Uuid, Set<Uuid>>();
  for (const arrangement of (await db.arrangements.toArray()) as Arrangement[]) {
    if (broken.has(`arrangement:${arrangement.id}`) || arrangement.deletedAt !== null) continue;
    for (const binding of arrangement.audioBindings) usedBy.set(binding.assetId, (usedBy.get(binding.assetId) ?? new Set()).add(arrangement.songId));
  }
  const assets = ((await db.assets.toArray()) as Asset[]).filter((asset) => !broken.has(`asset:${asset.id}`) && asset.deletedAt === null && usedBy.has(asset.id));
  let done = 0;
  for (const asset of assets) {
    options.onProgress?.(done, assets.length);
    done += 1;
    const row = await db.assetBlobs.get(assetBlobKey(asset.workspaceId, asset.sha256));
    let issue: MediaProblem['issue'] | null = null;
    if (!row) issue = 'missing';
    else if (row.state !== 'ready') issue = 'incomplete';
    else if (row.blob.size !== asset.byteSize) issue = 'corrupted';
    else if (options.verifyMedia) {
      const sha256 = await hashBlob(row.blob).catch(() => null);
      if (sha256 !== asset.sha256) issue = 'corrupted';
      else await db.assetBlobs.update(row.key, { verifiedAt: options.now });
    }
    if (!issue) continue;
    const songTitles: string[] = [];
    for (const songId of usedBy.get(asset.id) ?? []) songTitles.push(((await db.songs.get(songId)) as Song | undefined)?.title ?? 'louvor removido');
    problems.push({ kind: 'media', assetId: asset.id, filename: asset.filename, issue, repair: asset.remoteState === 'ready' ? 'download' : 'reimport', songTitles });
  }
  options.onProgress?.(assets.length, assets.length);
  return { checkedAt: options.now, documents, mediaFiles: assets.length, mediaVerified: options.verifyMedia, problems };
}

/**
 * Conserta um documento ilegível. O registro como estava vai para o histórico
 * (`corrupted`) antes de qualquer troca; então volta a última versão
 * confirmada pelo servidor ou a cópia válida mais recente. Sem nenhuma das
 * duas, o registro é retirado da biblioteca (continua guardado) e, em um
 * perfil de equipe, a próxima sincronização refaz a base a partir do servidor.
 */
export async function repairDocument(db: LocalDatabase, entityType: DocType, entityId: Uuid, now: IsoInstant): Promise<'server' | 'history' | 'removed'> {
  return db.transaction('rw', [tableOf(db, entityType), db.songIndex, db.entityStates, db.revisions, db.syncMeta, db.syncOperations], async () => {
    const table = tableOf(db, entityType);
    const row = await table.get(entityId);
    if (!row) throw new RecoveryError('not-found');
    if (valid(entityType, row)) throw new RecoveryError('not-deleted');
    const key = entityStateKey(entityType, entityId);
    const state = await db.entityStates.get(key);
    const workspaceId = state?.workspaceId ?? (typeof row.workspaceId === 'string' ? row.workspaceId : '');
    await db.revisions.put({ id: crypto.randomUUID(), entityType, entityId, workspaceId, createdAt: now, reason: 'corrupted', document: row as unknown as LocalRevision['document'] });

    const source = await repairSource(db, entityType, entityId);
    if (source) {
      await table.put(source.document);
      if (entityType === 'song') await db.songIndex.put(buildSongSearchEntry(source.document as unknown as Song));
      // Voltar à versão confirmada deixa o documento limpo; voltar ao histórico é uma alteração local.
      if (state) await db.entityStates.put({ ...state, dirty: source.from === 'server' ? 0 : 1, localGeneration: state.localGeneration + 1, blocked: null, updatedAt: now });
      return source.from;
    }
    await table.delete(entityId);
    if (entityType === 'song') await db.songIndex.delete(entityId);
    await db.entityStates.delete(key);
    await db.syncOperations.where('key').equals(key).delete();
    // Se a equipe tem este registro, só uma base nova o traz de volta.
    const meta = await db.syncMeta.get('sync');
    if (meta && state?.serverRevision) await db.syncMeta.put({ ...meta, needsBootstrap: true });
    return 'removed';
  });
}

/**
 * Descarta os bytes ruins de uma faixa que a equipe tem publicada, para que a
 * sincronização baixe e confira outra cópia. Não mexe em documentos.
 */
export async function discardMediaForDownload(db: LocalDatabase, assetId: Uuid): Promise<void> {
  const asset = await db.assets.get(assetId);
  if (!asset) throw new RecoveryError('not-found');
  if (asset.remoteState !== 'ready') throw new RecoveryError('unsupported');
  await db.assetBlobs.delete(assetBlobKey(asset.workspaceId, asset.sha256));
}
