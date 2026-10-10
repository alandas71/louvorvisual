import { describe, expect, it } from 'vitest';
import { AUDIO_FILE_ACCEPT, sniffAudioType } from './asset';

describe('identificação dos contêineres de áudio', () => {
  it.each([
    ['audio/mp4', [0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]],
    ['audio/aac', [0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]],
    ['audio/ogg', [79, 103, 103, 83, 0, 2]],
    ['audio/flac', [102, 76, 97, 67]],
    ['audio/webm', [0x1a, 0x45, 0xdf, 0xa3]],
    ['audio/mpeg', [0xff, 0xfb]],
  ])('identifica %s', (mimeType, bytes) => {
    expect(sniffAudioType(new Uint8Array(bytes))).toBe(mimeType);
  });

  it('recusa cabeçalhos vazios, truncados e inválidos', () => {
    for (const bytes of [[], [0xff, 0xf1], [0xff, 0xe8], [79, 103, 103, 83, 1], [0, 0, 0, 8, 102, 116, 121, 112, 77, 52, 65, 32]]) {
      expect(sniffAudioType(new Uint8Array(bytes))).toBeNull();
    }
  });

  it('inclui extensões de áudio usuais no seletor', () => {
    for (const extension of ['m4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mp3', 'wav']) {
      expect(AUDIO_FILE_ACCEPT.split(',')).toContain(`.${extension}`);
    }
  });
});
