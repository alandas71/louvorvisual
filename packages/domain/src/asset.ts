import type { AudioKind } from './arrangement';
import type { IsoInstant, Uuid } from './common';

/** Tipos canônicos compartilhados pela importação, pacotes e API. */
export const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm'] as const;
export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number];

export const AUDIO_FORMAT_LABEL = 'MP3, WAV, M4A, AAC, OGG/Opus, FLAC ou WebM';
export const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, AudioMimeType>> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
};
export const AUDIO_FILE_ACCEPT = [...Object.keys(AUDIO_MIME_BY_EXTENSION).map((extension) => `.${extension}`), ...AUDIO_MIME_TYPES].join(',');

/** Identifica o contêiner; a reprodução e integridade precisam ser verificadas separadamente. */
export function sniffAudioType(head: Uint8Array): AudioMimeType | null {
  const text = (start: number, length: number) => String.fromCharCode(...head.subarray(start, start + length));
  if (head.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return 'audio/wav';
  if (head.length >= 12 && text(4, 4) === 'ftyp') {
    const boxSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
    if (boxSize >= 16) return 'audio/mp4';
  }
  if (head.length >= 4 && text(0, 4) === 'fLaC') return 'audio/flac';
  if (head.length >= 5 && text(0, 4) === 'OggS' && head[4] === 0) return 'audio/ogg';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'audio/webm';
  // ADTS tem os bits de layer zerados; precisa vir antes do sincronismo MPEG.
  if (head.length >= 7 && head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) return 'audio/aac';
  if (head.length >= 3 && text(0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ((head[1] ?? 0) & 0x18) !== 0x08 && ((head[1] ?? 0) & 0x06) !== 0) return 'audio/mpeg';
  return null;
}

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
