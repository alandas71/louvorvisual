import type { Arrangement, Asset, IsoInstant, Setlist, Song, Theme, ThemeRef, Uuid } from '@louvorvisual/domain';
import { DEPENDENCY_ORDER, documentsOf, type PackageDocument } from './contents';
import type { PackageEntityType } from './manifest';
import type { OpenedPackage, PackageMedia } from './read';

/** Sufixo dos registros criados como cópia porque o destino já tinha outro conteúdo sob o mesmo ID. */
export const IMPORTED_SUFFIX = ' (importado)';

/** Chave de um registro de origem: o mesmo conteúdo, em qualquer pacote, leva ao mesmo registro local. */
export function originKey(originWorkspaceId: Uuid, entityType: PackageEntityType, originId: Uuid): string {
  return `${originWorkspaceId}:${entityType}:${originId}`;
}

/** Consultas ao armazenamento de destino. Nenhuma delas grava. */
export interface ImportLookup {
  /** Documento local com este ID, mesmo excluído; `null` se o ID nunca existiu aqui. */
  get(entityType: PackageEntityType, id: Uuid): Promise<PackageDocument | null>;
  /** Arquivo ativo do espaço com os mesmos bytes e o mesmo tipo de faixa. */
  findAsset(sha256: string, audioKind: Asset['audioKind']): Promise<Asset | null>;
  /** ID local para onde uma importação anterior levou este registro de origem. */
  mapped(key: string): Promise<Uuid | null>;
}

export type ImportTarget = {
  workspaceId: Uuid;
  userId: Uuid;
  now: IsoInstant;
  newId: () => Uuid;
  lookup: ImportLookup;
};

export type PlanAction =
  /** O destino já tem este conteúdo: nada é gravado. */
  | 'reuse'
  /** Mesmo espaço e ID livre: entra com o ID original. */
  | 'insert'
  /** Entra com ID novo e referências remapeadas. */
  | 'copy';

export type PlanItem = {
  entityType: PackageEntityType;
  originId: Uuid;
  targetId: Uuid;
  action: PlanAction;
  /** O destino tinha outro conteúdo sob o ID de origem (ou sob o ID de uma importação anterior). */
  diverged: boolean;
  title: string;
};

export type ImportPlan = {
  sameWorkspace: boolean;
  items: PlanItem[];
  /** Documentos a gravar, já remapeados, na ordem de dependência. */
  writes: { entityType: PackageEntityType; document: PackageDocument }[];
  /** Bytes que os documentos gravados ou reaproveitados usam. */
  media: PackageMedia[];
  /** Origem → ID local, para que repetir a importação não duplique nada. */
  mappings: { key: string; entityType: PackageEntityType; originId: Uuid; localId: Uuid }[];
  setlistId: Uuid;
  counts: Record<PlanAction, number>;
  diverged: number;
  mediaBytes: number;
};

/** Carimbos do servidor e de autoria: não fazem parte do conteúdo comparado. */
const STAMPS = ['serverRevision', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'remoteState', 'storageKey', 'basedOnSongRevision', 'deletedAt'] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Mesmo conteúdo autoral, ignorando carimbos. Dois documentos excluídos nunca chegam aqui. */
export function sameAuthoredContent(a: PackageDocument, b: PackageDocument): boolean {
  const strip = (document: PackageDocument) => {
    const copy: Record<string, unknown> = { ...document };
    for (const field of STAMPS) delete copy[field];
    return JSON.stringify(stable(copy));
  };
  return strip(a) === strip(b);
}

function titleOf(entityType: PackageEntityType, document: PackageDocument): string {
  if (entityType === 'song' || entityType === 'setlist') return (document as Song | Setlist).title;
  if (entityType === 'asset') return (document as Asset).filename;
  return (document as Arrangement | Theme).name;
}

function withSuffix(entityType: PackageEntityType, document: PackageDocument): PackageDocument {
  if (entityType === 'song' || entityType === 'setlist') return { ...(document as Song | Setlist), title: `${(document as Song).title}${IMPORTED_SUFFIX}` };
  if (entityType === 'arrangement' || entityType === 'theme') return { ...(document as Arrangement | Theme), name: `${(document as Arrangement).name}${IMPORTED_SUFFIX}` };
  return document;
}

/**
 * Decide, sem gravar, o destino de cada documento do pacote (planejamento/08):
 *
 * - **outro espaço**: tudo entra como cópia, com IDs novos e referências
 *   remapeadas;
 * - **mesmo espaço**: o ID só é preservado quando está livre ou quando o
 *   conteúdo local é igual; havendo divergência, entra uma cópia — o pacote
 *   nunca substitui um registro existente;
 * - quem referencia algo que mudou de ID também vira cópia, para não alterar
 *   um registro existente por tabela;
 * - bytes de áudio já presentes no espaço são reaproveitados pelo hash;
 * - uma importação anterior do mesmo registro é reconhecida: repetir a
 *   importação não cria duplicatas.
 */
export async function planImport(opened: OpenedPackage, target: ImportTarget): Promise<ImportPlan> {
  const { documents, manifest } = opened;
  const origin = manifest.origin.workspaceId;
  const sameWorkspace = origin === target.workspaceId;
  const ids = new Map<string, Uuid>();
  const idOf = (entityType: PackageEntityType, originId: Uuid) => ids.get(`${entityType}:${originId}`) ?? originId;
  const items: PlanItem[] = [];
  const writes: ImportPlan['writes'] = [];
  const mappings: ImportPlan['mappings'] = [];

  const themeRef = <T extends ThemeRef | null>(ref: T): T => (ref?.kind === 'workspace' ? ({ ...ref, themeId: idOf('theme', ref.themeId) } as T) : ref);

  /** O documento como ficaria no destino sob `id`: espaço e referências já trocados. */
  function retarget(entityType: PackageEntityType, document: PackageDocument, id: Uuid): { document: PackageDocument; rewired: boolean } {
    const base = { ...document, id, workspaceId: target.workspaceId };
    if (entityType === 'arrangement') {
      const source = document as Arrangement;
      const next: Arrangement = {
        ...(base as Arrangement),
        songId: idOf('song', source.songId),
        themeRef: themeRef(source.themeRef),
        audioBindings: source.audioBindings.map((binding) => ({ ...binding, assetId: idOf('asset', binding.assetId) })),
        basedOnSongRevision: null,
      };
      const rewired = next.songId !== source.songId || JSON.stringify(next.themeRef) !== JSON.stringify(source.themeRef) || next.audioBindings.some((binding, index) => binding.assetId !== source.audioBindings[index]?.assetId);
      return { document: next, rewired };
    }
    if (entityType === 'setlist') {
      const source = document as Setlist;
      const next: Setlist = { ...(base as Setlist), themeRef: themeRef(source.themeRef), items: source.items.map((item) => ({ ...item, arrangementId: idOf('arrangement', item.arrangementId) })) };
      const rewired = JSON.stringify(next.themeRef) !== JSON.stringify(source.themeRef) || next.items.some((item, index) => item.arrangementId !== source.items[index]?.arrangementId);
      return { document: next, rewired };
    }
    return { document: base as PackageDocument, rewired: false };
  }

  /** Registro novo no destino: nunca confirmado por servidor algum. */
  function fresh(entityType: PackageEntityType, document: PackageDocument, authored: boolean): PackageDocument {
    if (entityType === 'asset') {
      const asset = document as Asset;
      return { ...asset, remoteState: 'local', storageKey: null, deletedAt: null, ...(authored ? { createdAt: target.now, updatedAt: target.now } : {}) };
    }
    const aggregate = document as Song | Arrangement | Setlist | Theme;
    return { ...aggregate, serverRevision: null, deletedAt: null, ...(authored ? { createdBy: target.userId, updatedBy: target.userId, createdAt: target.now, updatedAt: target.now } : {}) };
  }

  for (const entityType of DEPENDENCY_ORDER) {
    for (const source of documentsOf(documents, entityType)) {
      const key = originKey(origin, entityType, source.id);
      const mappedId = await target.lookup.mapped(key);
      const candidates = [...new Set([...(mappedId ? [mappedId] : []), ...(sameWorkspace ? [source.id] : [])])];
      let chosen: { id: Uuid; action: PlanAction } | null = null;
      let existed = false;
      let activeExisted = false;

      if (entityType === 'asset') {
        const asset = source as Asset;
        const known = await target.lookup.findAsset(asset.sha256, asset.audioKind);
        if (known) chosen = { id: known.id, action: 'reuse' };
      }
      for (const candidate of chosen ? [] : candidates) {
        const local = await target.lookup.get(entityType, candidate);
        if (!local) continue;
        existed = true;
        if (local.deletedAt !== null || local.workspaceId !== target.workspaceId) continue;
        activeExisted = true;
        const wanted = retarget(entityType, source, candidate).document;
        if (sameAuthoredContent(local, wanted) || sameAuthoredContent(local, withSuffix(entityType, wanted))) {
          chosen = { id: candidate, action: 'reuse' };
          break;
        }
      }
      if (!chosen) {
        const free = sameWorkspace && !existed && (await target.lookup.get(entityType, source.id)) === null;
        // O ID original só é mantido quando as referências também ficaram como estavam.
        chosen = free && !retarget(entityType, source, source.id).rewired ? { id: source.id, action: 'insert' } : { id: target.newId(), action: 'copy' };
      }

      ids.set(`${entityType}:${source.id}`, chosen.id);
      const diverged = chosen.action === 'copy' && existed;
      if (chosen.action !== 'reuse') {
        let document = fresh(entityType, retarget(entityType, source, chosen.id).document, chosen.action === 'copy');
        // Só ganha sufixo a cópia que vai conviver com um registro ativo de mesmo nome.
        if (chosen.action === 'copy' && activeExisted) document = withSuffix(entityType, document);
        writes.push({ entityType, document });
      }
      mappings.push({ key, entityType, originId: source.id, localId: chosen.id });
      items.push({ entityType, originId: source.id, targetId: chosen.id, action: chosen.action, diverged, title: titleOf(entityType, source) });
    }
  }

  const counts: Record<PlanAction, number> = { reuse: 0, insert: 0, copy: 0 };
  for (const item of items) counts[item.action] += 1;
  const media = [...opened.media.values()];
  return {
    sameWorkspace,
    items,
    writes,
    media,
    mappings,
    setlistId: idOf('setlist', documents.setlist.id),
    counts,
    diverged: items.filter((item) => item.diverged).length,
    mediaBytes: media.reduce((total, item) => total + item.byteSize, 0),
  };
}
