import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('SHA-256 incremental', () => {
  it('confere com os vetores publicados (FIPS 180-4)', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(ascii('abc')).digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(new Sha256().update(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).digestHex()).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // Um milhão de "a", entregue em pedaços que não coincidem com o bloco de 64 bytes.
    const hash = new Sha256();
    const piece = ascii('a'.repeat(1000));
    for (let sent = 0; sent < 1000; sent += 1) hash.update(piece);
    expect(hash.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(hash.byteLength).toBe(1_000_000);
  });

  it('dá o mesmo resultado em qualquer divisão dos pedaços, inclusive nos limites de bloco', () => {
    for (const size of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = Uint8Array.from({ length: size }, (_, index) => (index * 31 + size) % 251);
      const whole = new Sha256().update(data).digestHex();
      for (const step of [1, 7, 64, 100, 65_536]) {
        const hash = new Sha256();
        for (let offset = 0; offset < size; offset += step) hash.update(data.subarray(offset, offset + step));
        expect(hash.digestHex(), `${size} bytes em pedaços de ${step}`).toBe(whole);
      }
    }
  });

  it('não aceita dados depois de concluído e repete o mesmo resultado', () => {
    const hash = new Sha256().update(new Uint8Array([1, 2, 3]));
    const first = hash.digestHex();
    expect(hash.digestHex()).toBe(first);
    expect(() => hash.update(new Uint8Array([4]))).toThrow();
  });
});
