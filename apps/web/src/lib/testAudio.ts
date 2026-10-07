/**
 * Áudio sintético para testes: nenhum arquivo de terceiros entra no repositório.
 * WAV PCM mono de 16 bits com um tom senoidal baixo.
 */
export function wavBytes(seconds: number, options: { sampleRate?: number; frequency?: number } = {}): Uint8Array<ArrayBuffer> {
  const sampleRate = options.sampleRate ?? 8000;
  const frequency = options.frequency ?? 440;
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((index / sampleRate) * 2 * Math.PI * frequency) * 2000), true);
  }
  return bytes;
}

/** MP3 silencioso: quadros MPEG-1 Layer III (128 kbps, 44,1 kHz) com dados zerados; 26 ms por quadro. */
export function silentMp3Bytes(frames: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  const bytes = new Uint8Array(frame.length * frames);
  for (let index = 0; index < frames; index += 1) bytes.set(frame, index * frame.length);
  return bytes;
}
