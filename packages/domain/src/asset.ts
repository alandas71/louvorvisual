import type { AudioKind } from './arrangement';
import type { IsoInstant, Uuid } from './common';

/** Formatos aceitos na proposta inicial (planejamento/06). */
export const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav'] as const;
export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number];

/** Limite inicial por faixa: 100 MiB. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

/** `ready` só após o servidor verificar bytes, tipo e checksum. */
export const ASSET_REMOTE_STATES = ['local', 'uploading', 'ready', 'failed'] as const;
export type AssetRemoteState = (typeof ASSET_REMOTE_STATES)[number];

/**
 * Metadados de um arquivo de áudio. Os bytes são imutáveis e identificados
 * pelo hash; URLs assinadas de download não fazem parte da identidade.
 */
export type Asset = {
  id: Uuid;
  workspaceId: Uuid;
  sha256: string;
  filename: string;
  mimeType: AudioMimeType;
  byteSize: number;
  audioKind: AudioKind;
  durationMs: number | null;
  remoteState: AssetRemoteState;
  storageKey: string | null;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  deletedAt: IsoInstant | null;
};
