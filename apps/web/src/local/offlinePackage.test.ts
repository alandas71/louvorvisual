import 'fake-indexeddb/auto';
import { addSetlistItem, createSetlist, deriveCues, touch, type Arrangement, type FontPackManifest, type Setlist } from '@louvorvisual/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { wavBytes } from '@/lib/testAudio';
import { importAudioFile, removeUnusedAudio, verifyAsset } from './assets';
import type { LocalDatabase } from './db';
import { offlinePackageStatus, prepareOfflinePackage, preparedItem, type PackageDeps } from './offlinePackage';
import { saveDocuments } from './repository';
import { assetBlobKey } from './schema';
import { deleteSetlist, listArrangementChoices, listSetlists, resolveSetlist } from './setlists';
import { sampleSong, testContext, testDatabase } from './testing';

const context = testContext();
let db: LocalDatabase;
afterEach(async () => {
  await db?.delete();
});

const FONTS: FontPackManifest = {
  version: '1',
  fonts: [
    { fontId: 'inter', family: 'Inter', version: '1', license: 'OFL-1.1', licenseFile: 'l', unicodeRange: 'U+0-FF', faces: [{ weight: 400, style: 'normal', file: 'inter-400.woff2', sha256: 'a'.repeat(64), byteSize: 1 }, { weight: 700, style: 'normal', file: 'inter-700.woff2', sha256: 'b'.repeat(64), byteSize: 1 }] },
    { fontId: 'lato', family: 'Lato', version: '1', license: 'OFL-1.1', licenseFile: 'l', unicodeRange: 'U+0-FF', faces: [{ weight: 400, style: 'normal', file: 'lato-400.woff2', sha256: 'c'.repeat(64), byteSize: 1 }] },
  ],
} as unknown as FontPackManifest;

function deps(overrides: Partial<PackageDeps> = {}): PackageDeps & { fontsChecked: string[]; progress: [number, number][] } {
  const fontsChecked: string[] = [];
  const progress: [number, number][] = [];
  return {
    fonts: FONTS,
    verifyFont: async (file) => {
      fontsChecked.push(file);
      return true;
    },
    probe: async () => 4000,
    now: () => context.now,
    newId: () => crypto.randomUUID(),
    onProgress: (done, total) => progress.push([done, total]),
    fontsChecked,
    progress,
    ...overrides,
  };
}

const audio = (frequency: number) => new Blob([wavBytes(4, { frequency })], { type: 'audio/wav' });

/** Dois louvores no repertório; o primeiro tem playback selecionado. */
async function scenario() {
  db = testDatabase();
  const first = sampleSong(context, 'Em União');
  const second = sampleSong(context, 'Manhã de Gratidão');
  const { asset } = await importAudioFile(db, { file: audio(440), filename: 'uniao-playback.wav', kind: 'playback', profileId: 'p', workspaceId: context.workspaceId, now: () => context.now, newId: () => crypto.randomUUID(), probe: async () => 4000 });
  const binding = { id: crypto.randomUUID(), assetId: asset.id, kind: 'playback' as const, policy: 'independent' as const, volume: 0.8, offsetMs: 0, cuesVersion: 0, cues: [] };
  const withAudio: Arrangement = { ...first.arrangement, audioBindings: [binding], selectedAudioBindingId: binding.id };
  let setlist: Setlist = createSetlist({ title: 'Culto de domingo', serviceDate: '2026-10-11', timeZone: 'America/Sao_Paulo' }, context);
  setlist = { ...setlist, items: addSetlistItem(addSetlistItem([], withAudio.id, context.newId), second.arrangement.id, context.newId) };
  await saveDocuments(db, [
    { entityType: 'song', document: first.song },
    { entityType: 'arrangement', document: withAudio },
    { entityType: 'song', document: second.song },
    { entityType: 'arrangement', document: second.arrangement },
    { entityType: 'setlist', document: setlist },
  ]);
  return { first: { song: first.song, arrangement: withAudio }, second, asset, binding, setlist };
}

describe('repertórios locais', () => {
  it('lista, resolve os itens na ordem e oferece os arranjos da biblioteca', async () => {
    const { setlist, first, second } = await scenario();
    expect((await listSetlists(db, context.workspaceId)).map((item) => item.id)).toEqual([setlist.id]);
    const entries = await resolveSetlist(db, setlist);
    expect(entries.map((entry) => entry.song?.title)).toEqual(['Em União', 'Manhã de Gratidão']);
    expect((await listArrangementChoices(db, context.workspaceId)).map((choice) => choice.arrangementId).sort()).toEqual([first.arrangement.id, second.arrangement.id].sort());
  });

  it('excluir o repertório é exclusão sincronizável e descarta a preparação', async () => {
    const { setlist } = await scenario();
    await prepareOfflinePackage(db, setlist.id, deps());
    await deleteSetlist(db, setlist.id, context);
    expect(await listSetlists(db, context.workspaceId)).toEqual([]);
    expect((await db.setlists.get(setlist.id))?.deletedAt).toBe(context.now);
    expect(await db.offlinePackages.count()).toBe(0);
  });
});

describe('preparação offline de um repertório', () => {
  it('sem preparar, o estado é "não preparado"', async () => {
    const { setlist } = await scenario();
    expect(await offlinePackageStatus(db, setlist.id)).toMatchObject({ state: 'notPrepared', usableCopy: false, problems: [] });
  });

  it('fica pronto só depois de conferir itens, bytes da faixa e arquivos de fonte', async () => {
    const { setlist, asset, first } = await scenario();
    const tools = deps();
    const status = await prepareOfflinePackage(db, setlist.id, tools);
    expect(status).toMatchObject({ state: 'ready', problems: [], staleReasons: [], items: 2, usableCopy: true });
    // Tema grafite → Inter, nos dois pesos; Lato não é exigida por este repertório.
    expect(tools.fontsChecked).toEqual(['inter-400.woff2', 'inter-700.woff2']);
    // Progresso por conferência concluída: 2 itens + 2 fontes.
    expect(tools.progress.at(-1)).toEqual([4, 4]);
    expect(tools.progress.map(([done]) => done)).toEqual([1, 2, 3, 4]);

    const row = await db.offlinePackages.get(setlist.id);
    expect(row?.ready?.items[0]).toMatchObject({ title: 'Em União', audio: { assetId: asset.id, sha256: asset.sha256, byteSize: asset.byteSize }, snapshot: { audio: { sha256: asset.sha256, policy: 'independent' } } });
    expect(row?.ready?.items[1]).toMatchObject({ title: 'Manhã de Gratidão', audio: null, snapshot: { audio: null } });
    expect(row?.ready?.fonts.map((font) => font.file)).toEqual(['inter-400.woff2', 'inter-700.woff2']);
    expect((await preparedItem(db, setlist.id, setlist.items[0]!.id))?.item.arrangementId).toBe(first.arrangement.id);
  });

  it('AT-15: faixa faltante não marca pronto; depois de recuperar e conferir, pronto; mudança posterior sinaliza revisão', async () => {
    const { setlist, asset, first } = await scenario();
    // A faixa some do dispositivo (dados limpos, download que não terminou).
    await db.assetBlobs.delete(assetBlobKey(asset.workspaceId, asset.sha256));

    const failed = await prepareOfflinePackage(db, setlist.id, deps());
    expect(failed).toMatchObject({ state: 'failed', usableCopy: false, items: 0 });
    expect(failed.problems).toEqual([{ code: 'audio-missing', itemId: setlist.items[0]!.id, arrangementId: first.arrangement.id, songId: first.song.id, subject: 'Em União', filename: 'uniao-playback.wav' }]);
    expect((await db.offlinePackages.get(setlist.id))?.ready).toBeNull();

    // O arquivo volta (reimportação ou download) e é conferido: agora sim, pronto.
    const again = await importAudioFile(db, { file: audio(440), filename: 'uniao-playback.wav', kind: 'playback', profileId: 'p', workspaceId: context.workspaceId, now: () => context.now, newId: () => crypto.randomUUID(), probe: async () => 4000 });
    expect(again.asset.id).toBe(asset.id);
    expect(await prepareOfflinePackage(db, setlist.id, deps())).toMatchObject({ state: 'ready', problems: [], items: 2 });

    // Mudança posterior no arranjo: a preparação fica desatualizada e diz onde.
    await saveDocuments(db, [{ entityType: 'arrangement', document: touch({ ...first.arrangement, name: 'Versão curta' }, { userId: context.userId, now: '2026-10-06T10:00:00.000Z' }) }]);
    const stale = await offlinePackageStatus(db, setlist.id);
    expect(stale).toMatchObject({ state: 'stale', usableCopy: true });
    expect(stale.staleReasons).toEqual([{ code: 'arrangement-changed', itemId: setlist.items[0]!.id, subject: 'Em União' }]);
    // A cópia pronta anterior continua utilizável, com a revisão que foi preparada.
    const copy = await preparedItem(db, setlist.id, setlist.items[0]!.id);
    expect(copy).toMatchObject({ newer: true, item: { arrangementName: 'Culto' } });
    expect(copy?.item.snapshot.arrangement.name).not.toBe('Versão curta');

    expect(await prepareOfflinePackage(db, setlist.id, deps())).toMatchObject({ state: 'ready', staleReasons: [] });
    expect((await preparedItem(db, setlist.id, setlist.items[0]!.id))?.item.snapshot.arrangement.name).toBe('Versão curta');
  });

  it('mudar o repertório, o louvor ou perder os bytes depois de pronto também sinaliza', async () => {
    const { setlist, asset, second } = await scenario();
    await prepareOfflinePackage(db, setlist.id, deps());

    await saveDocuments(db, [{ entityType: 'setlist', document: { ...setlist, items: addSetlistItem(setlist.items, second.arrangement.id, context.newId) } }]);
    await saveDocuments(db, [{ entityType: 'song', document: { ...second.song, title: 'Manhã Nova' } }]);
    await db.assetBlobs.delete(assetBlobKey(asset.workspaceId, asset.sha256));
    const status = await offlinePackageStatus(db, setlist.id);
    expect(status.state).toBe('stale');
    expect(status.staleReasons.map((reason) => reason.code)).toEqual(['setlist-changed', 'audio-missing', 'song-changed']);
  });

  it('AT-22: faixa corrompida ou ilegível não marca pronto e não derruba a cópia pronta anterior', async () => {
    const { setlist, asset } = await scenario();
    expect((await prepareOfflinePackage(db, setlist.id, deps())).state).toBe('ready');
    const key = assetBlobKey(asset.workspaceId, asset.sha256);
    const good = (await db.assetBlobs.get(key))!.blob;

    const bytes = new Uint8Array(await good.arrayBuffer());
    bytes[200] = (bytes[200] as number) ^ 0x55;
    await db.assetBlobs.update(key, { blob: new Blob([bytes]) });
    const corrupted = await prepareOfflinePackage(db, setlist.id, deps());
    expect(corrupted).toMatchObject({ state: 'failed', usableCopy: true, items: 2 });
    expect(corrupted.problems.map((problem) => [problem.code, problem.filename])).toEqual([['audio-corrupted', 'uniao-playback.wav']]);
    expect((await db.offlinePackages.get(setlist.id))?.ready?.items).toHaveLength(2);

    // Bytes íntegros que o navegador não consegue reproduzir.
    await db.assetBlobs.update(key, { blob: good });
    const unplayable = await prepareOfflinePackage(db, setlist.id, deps({ probe: async () => null }));
    expect(unplayable.problems.map((problem) => problem.code)).toEqual(['audio-unplayable']);

    expect((await prepareOfflinePackage(db, setlist.id, deps())).state).toBe('ready');
  });

  it('arquivo de fonte ausente, item sem arranjo e repertório vazio impedem o pronto', async () => {
    const { setlist, second } = await scenario();
    const noFont = await prepareOfflinePackage(db, setlist.id, deps({ verifyFont: async (file) => file !== 'inter-700.woff2' }));
    expect(noFont).toMatchObject({ state: 'failed' });
    expect(noFont.problems).toEqual([{ code: 'font-missing', subject: 'Inter', filename: 'inter-700.woff2' }]);

    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...second.arrangement, deletedAt: context.now } }]);
    const missing = await prepareOfflinePackage(db, setlist.id, deps());
    expect(missing.problems.map((problem) => problem.code)).toEqual(['arrangement-missing']);

    const empty = createSetlist({ title: 'Vazio', timeZone: 'America/Sao_Paulo' }, context);
    await saveDocuments(db, [{ entityType: 'setlist', document: empty }]);
    expect((await prepareOfflinePackage(db, empty.id, deps())).problems).toEqual([{ code: 'empty' }]);
  });

  it('faixa vinculada entra na cópia com os intervalos; a associação não selecionada pode faltar', async () => {
    const { setlist, first, binding, asset } = await scenario();
    const timed = first.arrangement.occurrences.map((occurrence) => ({ ...occurrence, durationMs: 1000 }));
    const original = { id: crypto.randomUUID(), assetId: crypto.randomUUID(), kind: 'original' as const, policy: 'independent' as const, volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] };
    const linked = { ...binding, policy: 'linked' as const, cues: deriveCues(timed, 0)!, cuesVersion: 1 };
    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...first.arrangement, occurrences: timed, audioBindings: [linked, original] } }]);
    const status = await prepareOfflinePackage(db, setlist.id, deps());
    expect(status.state).toBe('ready');
    const item = (await preparedItem(db, setlist.id, setlist.items[0]!.id))!.item;
    expect(item.snapshot.audio).toMatchObject({ policy: 'linked', sha256: asset.sha256 });
    expect(item.snapshot.audio?.cues).toHaveLength(timed.length);
  });

  it('repertório preparado segura os bytes da faixa contra a limpeza', async () => {
    const { setlist, first, asset } = await scenario();
    await prepareOfflinePackage(db, setlist.id, deps());
    // O arranjo deixa de usar a faixa, mas a cópia preparada ainda a usa.
    await saveDocuments(db, [{ entityType: 'arrangement', document: { ...first.arrangement, audioBindings: [], selectedAudioBindingId: null } }]);
    expect(await removeUnusedAudio(db, context.workspaceId)).toBe(0);
    expect(await verifyAsset(db, asset, context.now)).toBe('ok');
  });
});
