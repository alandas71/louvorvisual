import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalAssetStorage } from '../src/modules/identity/prisma-identity-store';

const root = mkdtempSync(join(tmpdir(), 'lv-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('armazenamento local de envio em partes', () => {
  it('acumula as partes, informa o tamanho, confere o hash em fluxo e publica movendo o arquivo', async () => {
    const storage = new LocalAssetStorage(root);
    const partial = join('espaco', 'arquivo.upload');
    const first = Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'binary');
    const second = Buffer.from('fmt resto do arquivo');
    expect(await storage.size(partial)).toBe(0);
    await storage.append(partial, first);
    expect(await storage.size(partial)).toBe(first.length);
    await storage.append(partial, second);
    expect(await storage.size(partial)).toBe(first.length + second.length);
    expect(await storage.head(partial, 12)).toEqual(first);
    expect(await storage.sha256(partial)).toBe(createHash('sha256').update(Buffer.concat([first, second])).digest('hex'));
    await storage.move(partial, join('espaco', 'final'));
    expect(await storage.size(partial)).toBe(0);
    expect(await storage.get(join('espaco', 'final'))).toEqual(Buffer.concat([first, second]));
  });
});
