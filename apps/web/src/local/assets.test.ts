import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { MAX_ASSET_BYTES } from '@louvorvisual/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentMp3Bytes, wavBytes } from '@/lib/testAudio';
import {
  AudioImportError,
  audioUsage,
  declaredAudioType,
  hashBlob,
  importAudioFile,
  readAssetBlob,
  removeUnusedAudio,
  sniffAudioType,
  verifyAsset,
  type ImportAudioInput,
  type ImportProgress,
} from './assets';
import type { LocalDatabase } from './db';
import { countPending, getEntityState, saveDocuments } from './repository';
import { assetBlobKey } from './schema';
import { sampleSong, testContext, testDatabase } from './testing';

const context = testContext();
const NOW = context.now;
let db: LocalDatabase;
afterEach(async () => {
  vi.restoreAllMocks();
  await db?.delete();
});

const wav = (seconds = 2, frequency = 440) => new Blob([wavBytes(seconds, { frequency })], { type: 'audio/wav' });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function input(file: Blob, overrides: Partial<ImportAudioInput> = {}): ImportAudioInput {
  return {
    file,
    filename: 'playback.wav',
    kind: 'playback',
    profileId: crypto.randomUUID(),
    workspaceId: context.workspaceId,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    probe: async () => 2000,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AudioImportError);
  expect((error as AudioImportError).code).toBe(code);
}

async function nothingStored() {
  expect(await db.assets.count()).toBe(0);
  expect(await db.assetBlobs.count()).toBe(0);
  expect(await countPending(db, context.workspaceId)).toBe(0);
}

describe('hash em fluxo', () => {
  it('confere com o SHA-256 de referência lendo o blob em pedaços', async () => {
    const bytes = wavBytes(30);
    const seen: number[] = [];
    expect(await hashBlob(new Blob([bytes]), (loaded) => seen.push(loaded))).toBe(sha(bytes));
    expect(seen.at(-1)).toBe(bytes.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('tipo do arquivo', () => {
  it.each([
    ['faixa.M4A', 'audio/x-m4a', 'audio/mp4'],
    ['faixa.m4a', 'video/mp4', 'audio/mp4'],
    ['faixa.m4a', 'application/octet-stream', 'audio/mp4'],
    ['faixa.aac', 'audio/aac', 'audio/aac'],
    ['faixa.opus', 'audio/ogg; codecs=opus', 'audio/ogg'],
    ['faixa.oga', 'application/ogg', 'audio/ogg'],
    ['faixa.flac', 'audio/x-flac', 'audio/flac'],
    ['faixa.webm', 'video/webm', 'audio/webm'],
  ])('normaliza o tipo de %s', (filename, type, canonical) => {
    expect(declaredAudioType(filename, type)).toBe(canonical);
    expect(declaredAudioType(filename, '')).toBe(canonical);
  });

  it('aceita MP3 e WAV quando extensão e tipo concordam', () => {
    expect(declaredAudioType('a.MP3', 'audio/mpeg')).toBe('audio/mpeg');
    expect(declaredAudioType('a.wav', 'audio/x-wav')).toBe('audio/wav');
    expect(declaredAudioType('a.wav', '')).toBe('audio/wav');
    expect(declaredAudioType('a.ogg', 'audio/ogg')).toBe('audio/ogg');
    expect(declaredAudioType('a.mp3', 'audio/wav')).toBeNull();
    expect(declaredAudioType('sem-extensao', 'audio/mpeg')).toBeNull();
  });

  it('confere o começo do arquivo', () => {
    expect(sniffAudioType(wavBytes(1))).toBe('audio/wav');
    expect(sniffAudioType(silentMp3Bytes(2))).toBe('audio/mpeg');
    expect(sniffAudioType(new TextEncoder().encode('ID3\u0003'))).toBe('audio/mpeg');
    expect(sniffAudioType(new TextEncoder().encode('isto não é áudio'))).toBeNull();
  });
});

describe('importação de áudio', () => {
  it.each([
    ['m4a', 'audio/mp4', [0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]],
    ['aac', 'audio/aac', [0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]],
    ['opus', 'audio/ogg', [79, 103, 103, 83, 0, 2]],
    ['flac', 'audio/flac', [102, 76, 97, 67]],
    ['webm', 'audio/webm', [0x1a, 0x45, 0xdf, 0xa3]],
  ])('importa %s com MIME genérico após verificar a reprodução', async (extension, mimeType, bytes) => {
    db = testDatabase();
    const probe = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe(mimeType);
      return 2000;
    });
    const file = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    const { asset } = await importAudioFile(db, input(file, { filename: `faixa.${extension}`, probe }));
    expect(asset.mimeType).toBe(mimeType);
    expect(probe.mock.calls[0]?.[0].type).toBe(mimeType);
    const stored = await db.assetBlobs.get(assetBlobKey(asset.workspaceId, asset.sha256));
    expect(stored?.blob.type).toBe(mimeType);
  });

  it('recusa M4A disfarçado ou que o navegador não reproduz sem guardar dados', async () => {
    db = testDatabase();
    await expectCode(importAudioFile(db, input(wav(), { filename: 'faixa.m4a' })), 'unsupported-type');
    const head = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
    await expectCode(importAudioFile(db, input(new Blob([head]), { filename: 'faixa.m4a', probe: async () => null })), 'unplayable');
    await nothingStored();
  });

  it('grava bytes e metadados, com identidade pelo hash, progresso real e pendência de sincronização', async () => {
    db = testDatabase();
    const bytes = wavBytes(2);
    const progress: ImportProgress[] = [];
    const { asset, reusedBytes } = await importAudioFile(db, input(new Blob([bytes], { type: 'audio/wav' }), { onProgress: (item) => progress.push(item) }));

    expect(reusedBytes).toBe(false);
    expect(asset).toMatchObject({ sha256: sha(bytes), byteSize: bytes.length, mimeType: 'audio/wav', audioKind: 'playback', durationMs: 2000, remoteState: 'local', filename: 'playback.wav' });
    const row = await db.assetBlobs.get(assetBlobKey(context.workspaceId, asset.sha256));
    expect(row).toMatchObject({ state: 'ready', byteSize: bytes.length, verifiedAt: NOW, sha256: asset.sha256 });
    expect(new Uint8Array(await row!.blob.arrayBuffer())).toEqual(bytes);
    expect(await getEntityState(db, 'asset', asset.id)).toMatchObject({ dirty: 1, localGeneration: 1 });

    // Progresso: fases na ordem e bytes que só crescem até o total.
    expect([...new Set(progress.map((item) => item.phase))]).toEqual(['reading', 'checking', 'storing', 'verifying']);
    expect(progress.every((item) => item.totalBytes === bytes.length && item.loadedBytes <= bytes.length)).toBe(true);
    expect(progress.filter((item) => item.phase === 'reading').at(-1)?.loadedBytes).toBe(bytes.length);
    expect(await verifyAsset(db, asset, NOW)).toBe('ok');
  });

  it('o mesmo arquivo importado de novo reaproveita os bytes e o registro', async () => {
    db = testDatabase();
    const first = await importAudioFile(db, input(wav()));
    const put = vi.spyOn(db.assetBlobs, 'put');
    const second = await importAudioFile(db, input(wav(), { filename: 'outro-nome.wav' }));
    expect(second).toMatchObject({ reusedBytes: true, asset: { id: first.asset.id, filename: 'playback.wav' } });
    expect(put).not.toHaveBeenCalled();
    expect(await db.assetBlobs.count()).toBe(1);

    // Como áudio original é outro registro, sobre os mesmos bytes.
    const original = await importAudioFile(db, input(wav(), { kind: 'original' }));
    expect(original.asset.id).not.toBe(first.asset.id);
    expect(original.asset.sha256).toBe(first.asset.sha256);
    expect(await db.assetBlobs.count()).toBe(1);
    expect(await db.assets.count()).toBe(2);
  });

  it('bytes são privados por espaço mesmo com o mesmo hash', async () => {
    db = testDatabase();
    const a = await importAudioFile(db, input(wav()));
    const other = crypto.randomUUID();
    const b = await importAudioFile(db, input(wav(), { workspaceId: other }));
    expect(b.reusedBytes).toBe(false);
    expect(await db.assetBlobs.count()).toBe(2);
    expect(await readAssetBlob(db, other, a.asset.sha256)).not.toBeNull();
  });

  it('recusa formato não aceito, conteúdo que não confere, vazio e acima do limite, sem gravar', async () => {
    db = testDatabase();
    await expectCode(importAudioFile(db, input(wav(), { filename: 'faixa.ogg' })), 'unsupported-type');
    await expectCode(importAudioFile(db, input(new Blob(['texto disfarçado de áudio'], { type: 'audio/wav' }))), 'unsupported-type');
    await expectCode(importAudioFile(db, input(new Blob([], { type: 'audio/wav' }))), 'empty');
    const huge = { size: MAX_ASSET_BYTES + 1, type: 'audio/wav' } as Blob;
    await expectCode(importAudioFile(db, input(huge)), 'too-large');
    await nothingStored();
  });

  it('arquivo que o navegador não consegue ler não é guardado', async () => {
    db = testDatabase();
    // Cabeçalho de WAV válido seguido de lixo: passa pelo tipo, falha nos metadados.
    const broken = new Blob([wavBytes(1).subarray(0, 12), new Uint8Array(500).fill(7)], { type: 'audio/wav' });
    await expectCode(importAudioFile(db, input(broken, { probe: async () => null })), 'unplayable');
    await expectCode(importAudioFile(db, input(wav(), { probe: async () => Promise.reject(new Error('decode')) })), 'unplayable');
    await nothingStored();
  });

  it('sem espaço estimado suficiente, recusa antes de escrever', async () => {
    db = testDatabase();
    const put = vi.spyOn(db.assetBlobs, 'put');
    await expectCode(importAudioFile(db, input(wav(), { freeSpace: async () => 1000 })), 'quota');
    expect(put).not.toHaveBeenCalled();
    await nothingStored();
  });

  it('QuotaExceededError na escrita dos bytes: nada fica disponível e o que existia continua intacto', async () => {
    db = testDatabase();
    const kept = await importAudioFile(db, input(wav(2, 440)));
    const { song, arrangement } = sampleSong(context);
    await saveDocuments(db, [{ entityType: 'song', document: song }, { entityType: 'arrangement', document: arrangement }]);
    const pending = await countPending(db, context.workspaceId);

    vi.spyOn(db.assetBlobs, 'put').mockRejectedValueOnce(Object.assign(new Error('cheio'), { name: 'QuotaExceededError' }));
    await expectCode(importAudioFile(db, input(wav(3, 880))), 'quota');

    expect(await db.assetBlobs.count()).toBe(1);
    expect(await db.assets.count()).toBe(1);
    expect(await countPending(db, context.workspaceId)).toBe(pending);
    expect(await verifyAsset(db, kept.asset, NOW)).toBe('ok');
    expect(await db.songs.get(song.id)).toEqual(song);
  });

  it('falha ao publicar os metadados desfaz os bytes em preparação', async () => {
    db = testDatabase();
    vi.spyOn(db.assets, 'put').mockRejectedValueOnce(Object.assign(new Error('cheio'), { name: 'QuotaExceededError' }));
    await expectCode(importAudioFile(db, input(wav())), 'quota');
    await nothingStored();
  });

  it('bytes gravados diferentes dos lidos não são publicados', async () => {
    db = testDatabase();
    const file = wav();
    const original = db.assetBlobs.get.bind(db.assetBlobs);
    // A leitura de conferência devolve outro conteúdo, como um disco que corrompeu a escrita.
    vi.spyOn(db.assetBlobs, 'get').mockImplementation((async (key: string) => {
      const row = await original(key);
      return row && row.state === 'staged' ? { ...row, blob: new Blob([new Uint8Array(row.byteSize).fill(1)]) } : row;
    }) as typeof db.assetBlobs.get);
    await expectCode(importAudioFile(db, input(file)), 'storage');
    vi.restoreAllMocks();
    await nothingStored();
  });

  it('escrita interrompida (em preparação) nunca conta como arquivo disponível', async () => {
    db = testDatabase();
    const bytes = wavBytes(2);
    const key = assetBlobKey(context.workspaceId, sha(bytes));
    await db.assetBlobs.put({ key, profileId: 'p', workspaceId: context.workspaceId, sha256: sha(bytes), byteSize: bytes.length, mimeType: 'audio/wav', blob: new Blob([bytes]), state: 'staged', storedAt: NOW, verifiedAt: null });
    expect(await readAssetBlob(db, context.workspaceId, sha(bytes))).toBeNull();
    expect(await verifyAsset(db, { workspaceId: context.workspaceId, sha256: sha(bytes), byteSize: bytes.length }, NOW)).toBe('missing');
    // Importar de novo conclui a escrita.
    const { asset, reusedBytes } = await importAudioFile(db, input(new Blob([bytes], { type: 'audio/wav' })));
    expect(reusedBytes).toBe(false);
    expect(await verifyAsset(db, asset, NOW)).toBe('ok');
  });
});

describe('integridade', () => {
  it('distingue ausente, tamanho diferente e conteúdo alterado; só o íntegro registra verificação', async () => {
    db = testDatabase();
    const { asset } = await importAudioFile(db, input(wav()));
    const key = assetBlobKey(asset.workspaceId, asset.sha256);
    const later = '2026-10-06T08:00:00.000Z';

    const tampered = new Uint8Array(await (await readAssetBlob(db, asset.workspaceId, asset.sha256))!.arrayBuffer());
    tampered[100] = (tampered[100] as number) ^ 0xff;
    await db.assetBlobs.update(key, { blob: new Blob([tampered]) });
    expect(await verifyAsset(db, asset, later)).toBe('corrupted');
    await db.assetBlobs.update(key, { blob: new Blob([tampered.subarray(0, 500)]) });
    expect(await verifyAsset(db, asset, later)).toBe('corrupted');
    expect((await db.assetBlobs.get(key))?.verifiedAt).toBe(NOW);

    // Bytes corrompidos com o mesmo tamanho: reimportar o arquivo certo os substitui, em vez de reaproveitá-los.
    await db.assetBlobs.update(key, { blob: new Blob([tampered]) });
    const repaired = await importAudioFile(db, input(wav(), { now: () => later }));
    expect(repaired).toMatchObject({ reusedBytes: false, asset: { id: asset.id } });
    expect(await verifyAsset(db, asset, later)).toBe('ok');

    await db.assetBlobs.delete(key);
    expect(await verifyAsset(db, asset, later)).toBe('missing');

    // Importar o mesmo arquivo de novo recupera os bytes para o mesmo registro.
    const again = await importAudioFile(db, input(wav(), { now: () => later }));
    expect(again).toMatchObject({ reusedBytes: false, asset: { id: asset.id } });
    expect(await verifyAsset(db, asset, later)).toBe('ok');
    expect((await db.assetBlobs.get(key))?.verifiedAt).toBe(later);
  });
});

describe('espaço e remoção', () => {
  it('remove só bytes sem referência; arranjo e sessão ativa seguram o arquivo', async () => {
    db = testDatabase();
    const used = await importAudioFile(db, input(wav(2, 440)));
    const inSession = await importAudioFile(db, input(wav(2, 660)));
    const loose = await importAudioFile(db, input(wav(2, 880)));
    const { song, arrangement } = sampleSong(context);
    const binding = { id: crypto.randomUUID(), assetId: used.asset.id, kind: 'playback' as const, policy: 'independent' as const, volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] };
    await saveDocuments(db, [{ entityType: 'song', document: song }, { entityType: 'arrangement', document: { ...arrangement, audioBindings: [binding], selectedAudioBindingId: binding.id } }]);
    await db.presentationSessions.add({
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      songId: song.id,
      arrangementId: arrangement.id,
      status: 'active',
      createdAt: NOW,
      snapshot: { workspaceId: context.workspaceId, audio: { sha256: inSession.asset.sha256 } } as never,
      baseArrangement: arrangement,
    });

    expect(await audioUsage(db, context.workspaceId)).toEqual({ files: 3, bytes: used.asset.byteSize * 3, unusedFiles: 1, unusedBytes: loose.asset.byteSize });
    expect(await removeUnusedAudio(db, context.workspaceId)).toBe(1);
    expect(await verifyAsset(db, used.asset, NOW)).toBe('ok');
    expect(await verifyAsset(db, inSession.asset, NOW)).toBe('ok');
    expect(await verifyAsset(db, loose.asset, NOW)).toBe('missing');
    // Metadados não são apagados por "limpar": o registro continua na biblioteca.
    expect(await db.assets.count()).toBe(3);
    expect(await removeUnusedAudio(db, context.workspaceId)).toBe(0);
  });
});
