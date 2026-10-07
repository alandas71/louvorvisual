import type { SyncDoc, SyncEntityType } from './types';
import { entityKey } from './types';

/** Revisões e cursores são decimais opacos e podem passar de 2^53: comparar sem `number`. */
export function revisionNumber(revision: string | null | undefined): bigint {
  return revision ? BigInt(revision) : 0n;
}

export function isNewerRevision(candidate: string, known: string | null | undefined): boolean {
  return revisionNumber(candidate) > revisionNumber(known);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Campos atribuídos pelo servidor ou só de controle: não fazem parte do conteúdo comparado. */
const STAMPED = ['serverRevision', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'remoteState', 'storageKey', 'basedOnSongRevision'] as const;

/**
 * Mesmo conteúdo autoral, ignorando carimbos do servidor. A exclusão é
 * comparada como estado (excluído ou não), porque o instante é do servidor.
 */
export function sameContent(a: SyncDoc, b: SyncDoc): boolean {
  const strip = (document: SyncDoc) => {
    const copy: Record<string, unknown> = { ...document, deletedAt: document.deletedAt === null ? null : 'deleted' };
    for (const field of STAMPED) delete copy[field];
    return JSON.stringify(stable(copy));
  };
  return strip(a) === strip(b);
}

type ThemeRef = { kind: string; themeId?: string } | null | undefined;

/** Chaves dos agregados que precisam estar confirmados antes de este ser enviado. */
export function dependenciesOf(entityType: SyncEntityType, document: SyncDoc): string[] {
  const fields = document as Record<string, unknown>;
  const keys: string[] = [];
  const theme = fields.themeRef as ThemeRef;
  if (theme?.kind === 'workspace' && theme.themeId) keys.push(entityKey('theme', theme.themeId));
  if (entityType === 'arrangement') {
    keys.push(entityKey('song', fields.songId as string));
    for (const binding of (fields.audioBindings as { assetId: string }[] | undefined) ?? []) keys.push(entityKey('asset', binding.assetId));
  }
  if (entityType === 'setlist') {
    for (const item of (fields.items as { arrangementId: string }[] | undefined) ?? []) keys.push(entityKey('arrangement', item.arrangementId));
  }
  return [...new Set(keys)];
}

/** Nome legível de um documento, para as telas de pendência e conflito. */
export function documentTitle(document: SyncDoc): string {
  const fields = document as Record<string, unknown>;
  return String(fields.title ?? fields.name ?? fields.filename ?? document.id);
}
