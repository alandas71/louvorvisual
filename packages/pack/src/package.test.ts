import { describe, expect, it } from 'vitest';
import { buildPackage, packageFilename } from './build';
import { PackageError, type PackageErrorCode } from './errors';
import { documentPath, MANIFEST_PATH, mediaPath, PACKAGE_FORMAT, type PackageManifest } from './manifest';
import { openPackage } from './read';
import { build, mediaBytes, repack, sample, source } from './testing';
import { readZip, writeZip } from './zip';

async function expectCode(promise: Promise<unknown>, code: PackageErrorCode): Promise<PackageError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, `esperava a recusa ${code}`).toBeInstanceOf(PackageError);
  expect((error as PackageError).code).toBe(code);
  return error as PackageError;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('pacote íntegro', () => {
  it('exporta e reabre: mesmos documentos, mesmos bytes, manifesto com tamanho e SHA-256 de cada arquivo', async () => {
    const input = sample();
    const { file, manifest, filename } = await build(input);
    expect(filename).toBe('repertorio-culto-de-domingo-20261006.louvorvisual.zip');
    expect(manifest).toMatchObject({ format: PACKAGE_FORMAT, formatVersion: 1, minReaderVersion: 1, schemaVersion: 1, fontPackVersion: '1', mediaPolicy: 'all', omittedMedia: [] });
    expect(manifest.builtin).toEqual({ themePresetIds: ['grafite'], fontIds: ['inter'] });
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      [
        documentPath('asset', input.playback.id),
        documentPath('asset', input.original.id),
        documentPath('theme', input.documents.themes[0]!.id),
        documentPath('song', input.documents.songs[0]!.id),
        documentPath('arrangement', input.documents.arrangements[0]!.id),
        documentPath('setlist', input.documents.setlist.id),
        mediaPath(input.playback.sha256),
        mediaPath(input.original.sha256),
      ].sort(),
    );

    const opened = await openPackage(file);
    expect(opened.totalBytes).toBe(file.size);
    expect(opened.documents.setlist).toEqual(input.documents.setlist);
    expect(opened.documents.songs).toEqual(input.documents.songs);
    expect(opened.documents.arrangements).toEqual(input.documents.arrangements);
    expect(opened.documents.themes).toEqual(input.documents.themes);
    expect(await bytesOf(opened.media.get(input.playback.sha256)!.blob)).toEqual(mediaBytes(4096, 7));
    expect(await bytesOf(opened.media.get(input.original.sha256)!.blob)).toEqual(mediaBytes(2048, 99));
  });

  it('AT-18: nenhum token, cookie, senha ou chave de armazenamento sai no pacote', async () => {
    const input = sample();
    const { file } = await build(input);
    const text = new TextDecoder('latin1').decode(await bytesOf(file));
    // A chave do servidor de arquivos estava no documento local e não foi copiada.
    expect(input.playback.storageKey).toBe('espaco/segredo-do-servidor');
    expect(text).not.toContain('segredo-do-servidor');
    const opened = await openPackage(file);
    expect(opened.documents.assets.map((asset) => [asset.storageKey, asset.remoteState])).toEqual([
      [null, 'local'],
      [null, 'local'],
    ]);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    for (const entry of await readZip(file, { maxEntries: 100 })) if (entry.path.endsWith('.json')) walk(JSON.parse(await entry.data.text()));
    expect([...keys].filter((key) => /token|cookie|senha|password|secret|session|email|invit|convite|deviceId|opId/i.test(key))).toEqual([]);
  });

  it('documento com campo fora do esquema (por exemplo, um token) não é exportado', async () => {
    const input = sample();
    (input.documents.songs[0] as unknown as Record<string, unknown>).accessToken = 'abc';
    await expectCode(buildPackage(source(input)), 'document-invalid');
  });

  it('política de mídia: só a faixa escolhida, ou nenhuma, fica declarada no manifesto', async () => {
    const input = sample();
    const selected = await build(input, { mediaPolicy: 'selected' });
    expect(selected.manifest.entries.filter((entry) => entry.kind === 'media').map((entry) => entry.path)).toEqual([mediaPath(input.playback.sha256)]);
    expect(selected.manifest.omittedMedia).toEqual([{ assetId: input.original.id, sha256: input.original.sha256, byteSize: 2048, reason: 'not-selected' }]);
    expect((await openPackage(selected.file)).media.size).toBe(1);

    const none = await build(input, { mediaPolicy: 'none' });
    expect(none.manifest.omittedMedia.map((item) => item.reason)).toEqual(['policy-none', 'policy-none']);
    const opened = await openPackage(none.file);
    expect(opened.media.size).toBe(0);
    expect(opened.documents.assets).toHaveLength(2);
  });

  it('AT-22: faixa ausente ou corrompida no dispositivo não entra como se estivesse íntegra', async () => {
    const input = sample();
    input.media.delete(input.original.sha256);
    const corrupted = mediaBytes(4096, 7);
    corrupted[100] = (corrupted[100] as number) ^ 0xff;
    input.media.set(input.playback.sha256, new Blob([corrupted]));
    const { file, manifest } = await build(input);
    expect(manifest.entries.filter((entry) => entry.kind === 'media')).toEqual([]);
    expect(manifest.omittedMedia.map((item) => [item.assetId, item.reason])).toEqual([
      [input.playback.id, 'unavailable'],
      [input.original.id, 'unavailable'],
    ]);
    expect((await openPackage(file)).media.size).toBe(0);
  });

  it('exportação recusa repertório com item sem arranjo, documento excluído ou de outro espaço', async () => {
    const broken = sample();
    broken.documents.setlist.items.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', arrangementId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', order: 2, notes: '' });
    expect((await expectCode(build(broken), 'incomplete')).details).toEqual([expect.stringContaining('arranjo que não está no pacote')]);
    const deleted = sample();
    deleted.documents.songs[0]!.deletedAt = '2026-10-06T00:00:00.000Z';
    await expectCode(build(deleted), 'incomplete');
    const foreign = sample();
    foreign.documents.songs[0]!.workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await expectCode(build(foreign), 'incomplete');
  });

  it('nome do arquivo não carrega acentos nem caracteres de caminho', () => {
    expect(packageFilename('Culto ../de Ação & Graças!', '2026-12-25T10:00:00.000Z')).toBe('repertorio-culto-de-acao-gracas-20261225.louvorvisual.zip');
    expect(packageFilename('   ', '2026-12-25T10:00:00.000Z')).toBe('repertorio-sem-titulo-20261225.louvorvisual.zip');
  });
});

describe('pacote adulterado ou corrompido', () => {
  it('um byte trocado na mídia, com o tamanho preservado', async () => {
    const input = sample();
    const { file } = await build(input);
    const changed = mediaBytes(4096, 7);
    changed[2000] = (changed[2000] as number) ^ 1;
    const error = await expectCode(openPackage(await repack(file, { files: { [mediaPath(input.playback.sha256)]: changed } })), 'hash-mismatch');
    expect(error.details).toEqual({ path: mediaPath(input.playback.sha256) });
  });

  it('um byte trocado direto no arquivo, sem refazer o CRC', async () => {
    const { file } = await build();
    const bytes = await bytesOf(file);
    const position = bytes.length - 3000;
    bytes[position] = (bytes[position] as number) ^ 0x55;
    const error = await openPackage(new Blob([bytes])).then(
      () => null,
      (reason: PackageError) => reason,
    );
    expect(error).toBeInstanceOf(PackageError);
    expect(['hash-mismatch', 'not-a-package', 'manifest-invalid']).toContain(error!.code);
  });

  it('letra alterada em um documento, com o manifesto antigo', async () => {
    const input = sample();
    const { file } = await build(input);
    const path = documentPath('song', input.documents.songs[0]!.id);
    const tampered = JSON.stringify({ ...input.documents.songs[0], title: 'Título trocado' });
    await expectCode(openPackage(await repack(file, { files: { [path]: tampered } })), 'hash-mismatch');
  });

  it('mesmo com os hashes refeitos, documento fora do esquema ou com campo estranho é recusado', async () => {
    const input = sample();
    const { file } = await build(input);
    const path = documentPath('song', input.documents.songs[0]!.id);
    const withToken = JSON.stringify({ ...input.documents.songs[0], refreshToken: 'roubado' });
    await expectCode(openPackage(await repack(file, { files: { [path]: withToken }, fixHashes: true })), 'document-invalid');
    await expectCode(openPackage(await repack(file, { files: { [path]: '{"id":1}' }, fixHashes: true })), 'document-invalid');
    await expectCode(openPackage(await repack(file, { files: { [path]: 'não é json' }, fixHashes: true })), 'document-invalid');
    const otherId = JSON.stringify({ ...input.documents.songs[0], id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    await expectCode(openPackage(await repack(file, { files: { [path]: otherId }, fixHashes: true })), 'document-invalid');
  });

  it('mesmo com os hashes refeitos, referência a outro espaço ou a conteúdo fora do pacote é recusada', async () => {
    const input = sample();
    const { file } = await build(input);
    const arrangement = input.documents.arrangements[0]!;
    const path = documentPath('arrangement', arrangement.id);
    const outside = JSON.stringify({ ...arrangement, songId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    await expectCode(openPackage(await repack(file, { files: { [path]: outside }, fixHashes: true })), 'reference-broken');
    const foreign = JSON.stringify({ ...arrangement, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await expectCode(openPackage(await repack(file, { files: { [path]: foreign }, fixHashes: true })), 'reference-broken');
    const deleted = JSON.stringify({ ...arrangement, deletedAt: '2026-10-06T00:00:00.000Z' });
    await expectCode(openPackage(await repack(file, { files: { [path]: deleted }, fixHashes: true })), 'reference-broken');
  });

  it('arquivo a mais, arquivo a menos e mídia de outro arquivo', async () => {
    const input = sample();
    const { file } = await build(input);
    await expectCode(openPackage(await repack(file, { files: { 'scripts/instalar.js': 'alert(1)' } })), 'unexpected-file');
    await expectCode(openPackage(await repack(file, { files: { 'media/extra': 'x' } })), 'unexpected-file');
    await expectCode(openPackage(await repack(file, { files: { [mediaPath(input.original.sha256)]: null } })), 'missing-file');
    // Bytes retirados do manifesto sem declarar a ausência.
    const silent = await repack(file, {
      files: { [mediaPath(input.original.sha256)]: null },
      manifest: (manifest) => void (manifest.entries = manifest.entries.filter((entry) => entry.path !== mediaPath(input.original.sha256))),
    });
    await expectCode(openPackage(silent), 'missing-file');
  });

  it('caminhos externos, absolutos ou fora do padrão', async () => {
    const { file } = await build();
    const data = new Blob(['x']);
    for (const path of ['../fora.json', '/etc/passwd', 'documents/../../x', 'documents\\song\\x.json', 'media/', 'a//b']) {
      expect(() => writeZip([{ path, data, crc32: 0 }]), path).toThrow(PackageError);
    }
    const moved = await repack(file, { manifest: (manifest) => void (manifest.entries[0]!.path = 'documents/asset/outro-nome.json') });
    await expectCode(openPackage(moved), 'unsafe-path');
  });

  it('ZIP truncado, com sobras, comprimido ou com caminho perigoso gravado por outra ferramenta', async () => {
    const { file } = await build();
    const bytes = await bytesOf(file);
    await expectCode(openPackage(new Blob([bytes.subarray(0, bytes.length - 40)])), 'not-a-package');
    await expectCode(openPackage(new Blob([bytes, new Uint8Array(8)])), 'not-a-package');
    await expectCode(openPackage(new Blob([new Uint8Array(8), bytes])), 'not-a-package');
    await expectCode(openPackage(new Blob(['isto não é um zip, só um texto qualquer'])), 'not-a-package');
    await expectCode(openPackage(new Blob([])), 'not-a-package');

    // Método de compressão 8 (deflate) declarado só no índice, e só no cabeçalho local da primeira entrada.
    const centralOffset = new DataView(bytes.buffer, bytes.byteOffset).getUint32(bytes.length - 6, true);
    const inIndex = bytes.slice();
    new DataView(inIndex.buffer).setUint16(centralOffset + 10, 8, true);
    expect((await expectCode(openPackage(new Blob([inIndex])), 'not-a-package')).message).toContain('entrada comprimida');
    const inLocal = bytes.slice();
    new DataView(inLocal.buffer).setUint16(8, 8, true);
    expect((await expectCode(openPackage(new Blob([inLocal])), 'not-a-package')).message).toContain('diferente do índice');
    // Bit de criptografia no índice.
    const encrypted = bytes.slice();
    new DataView(encrypted.buffer).setUint16(centralOffset + 8, 0x0801, true);
    expect((await expectCode(openPackage(new Blob([encrypted])), 'not-a-package')).message).toContain('criptografada');

    // Mesmo tamanho de nome, conteúdo trocado por um caminho que sobe de pasta.
    const traversal = bytes.slice();
    const name = new TextEncoder().encode('../ifest.json');
    expect(name.length).toBe(MANIFEST_PATH.length);
    traversal.set(name, 30);
    traversal.set(name, centralOffset + 46);
    await expectCode(openPackage(new Blob([traversal])), 'unsafe-path');
  });

  it('índice declarado maior do que as entradas permitem é recusado sem ser carregado na memória', async () => {
    // Fim de arquivo que declara uma única entrada e um índice de 8 MiB: o leitor
    // não pode ler esse intervalo inteiro só para descobrir que é lixo.
    const padding = 8 * 1024 * 1024;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, padding, true);
    end.setUint32(16, 0, true);
    const file = new Blob([new Uint8Array(padding), end.buffer]);
    let largest = 0;
    const watched = {
      size: file.size,
      slice: (start: number, finish: number) => {
        largest = Math.max(largest, finish - start);
        return file.slice(start, finish);
      },
    } as unknown as Blob;
    await expectCode(readZip(watched, { maxEntries: 1000 }), 'not-a-package');
    expect(largest).toBeLessThan(64 * 1024);
  });

  it('limites: quantidade de arquivos, tamanho total e tamanho por documento', async () => {
    const { file } = await build();
    await expectCode(openPackage(file, { limits: { maxEntries: 3 } }), 'too-large');
    await expectCode(openPackage(file, { limits: { maxTotalBytes: 1000 } }), 'too-large');
    await expectCode(openPackage(file, { limits: { maxDocumentBytes: 50 } }), 'too-large');
    await expectCode(openPackage(file, { limits: { maxMediaBytes: 1000 } }), 'too-large');
  });

  it('sem manifesto, ou com manifesto que não é deste formato', async () => {
    const { file } = await build();
    const entries = (await readZip(file, { maxEntries: 100 })).filter((entry) => entry.path !== MANIFEST_PATH);
    await expectCode(openPackage(writeZip(entries)), 'manifest-missing');
    await expectCode(openPackage(await repack(file, { manifest: (manifest) => void ((manifest as Record<string, unknown>).format = 'outro-formato') })), 'manifest-invalid');
    await expectCode(openPackage(await repack(file, { manifest: (manifest) => void delete (manifest as Partial<PackageManifest>).scope })), 'manifest-invalid');
  });
});

describe('versão incompatível', () => {
  it('formato que exige leitor mais novo é recusado pelo motivo certo, mesmo com campos desconhecidos', async () => {
    const { file } = await build();
    const future = await repack(file, {
      manifest: (manifest) => {
        manifest.formatVersion = 3;
        manifest.minReaderVersion = 2;
        (manifest as Record<string, unknown>).entries = [{ kind: 'video', path: 'video/x' }];
      },
    });
    const error = await expectCode(openPackage(future), 'format-too-new');
    expect(error.details).toEqual({ minReaderVersion: 2, readerVersion: 1 });
    expect(error.message).toContain('Atualize o aplicativo');
  });

  it('formato mais novo, mas declarado legível por este leitor, é aceito e os campos novos são ignorados', async () => {
    const input = sample();
    const { file } = await build(input);
    const compatible = await repack(file, {
      manifest: (manifest) => {
        manifest.formatVersion = 2;
        manifest.campoNovo = { qualquer: 'coisa' };
      },
    });
    const opened = await openPackage(compatible);
    expect(opened.manifest.formatVersion).toBe(2);
    expect(opened.manifest).not.toHaveProperty('campoNovo');
    expect(opened.documents.songs).toEqual(input.documents.songs);
  });

  it('esquema de documentos mais novo, mais antigo sem conversão e pacote de fontes diferente', async () => {
    const { file } = await build();
    await expectCode(openPackage(await repack(file, { manifest: (manifest) => void (manifest.schemaVersion = 2) })), 'schema-too-new');
    // Um aplicativo futuro (esquema 3) sem conversão registrada a partir da versão 1.
    await expectCode(openPackage(file, { support: { schemaVersion: 3 } }), 'schema-unsupported');
    await expectCode(openPackage(await repack(file, { manifest: (manifest) => void (manifest.fontPackVersion = '2') })), 'font-pack-incompatible');
    await expectCode(openPackage(file, { support: { fontPackVersion: '2' } }), 'font-pack-incompatible');
  });

  it('tema ou fonte de fábrica que o aplicativo de destino não tem', async () => {
    const { file } = await build();
    const error = await expectCode(openPackage(file, { support: { hasThemePreset: () => false } }), 'catalog-missing');
    expect(error.details).toEqual(['tema grafite']);
    await expectCode(openPackage(file, { support: { hasFont: (id) => id !== 'inter' } }), 'catalog-missing');
  });
});
