import type { Arrangement, Asset, Setlist, Song, Theme } from '@louvorvisual/domain';
import { describe, expect, it } from 'vitest';
import { referenceProblems, type PackageDocuments } from './contents';
import { IMPORTED_SUFFIX, originKey, planImport, type ImportPlan, type ImportTarget } from './plan';
import { openPackage } from './read';
import { build, IMPORTER, MemoryLibrary, nextId, NOW, ORIGIN_WORKSPACE, OTHER_WORKSPACE, sample, type Sample } from './testing';

function target(library: MemoryLibrary, workspaceId: string): ImportTarget {
  return { workspaceId, userId: IMPORTER, now: NOW, newId: nextId, lookup: library };
}

async function opened(input: Sample = sample()) {
  return openPackage((await build(input)).file);
}

/** Os documentos do repertório importado, lidos da biblioteca de destino pelo plano. */
function imported(library: MemoryLibrary, plan: ImportPlan): PackageDocuments {
  const of = <T>(entityType: 'song' | 'arrangement' | 'asset' | 'theme') =>
    plan.items.filter((item) => item.entityType === entityType).map((item) => library.find(entityType, item.targetId) as T);
  return { setlist: library.find('setlist', plan.setlistId) as Setlist, arrangements: of<Arrangement>('arrangement'), songs: of<Song>('song'), assets: of<Asset>('asset'), themes: of<Theme>('theme') };
}

function seed(library: MemoryLibrary, input: Sample): void {
  for (const asset of input.documents.assets) library.put('asset', asset);
  for (const theme of input.documents.themes) library.put('theme', theme);
  for (const song of input.documents.songs) library.put('song', song);
  for (const arrangement of input.documents.arrangements) library.put('arrangement', arrangement);
  library.put('setlist', input.documents.setlist);
}

describe('plano de importação', () => {
  it('AT-18: outro espaço — tudo entra como cópia, com IDs novos e todas as referências remapeadas', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    const plan = await planImport(await opened(input), target(library, OTHER_WORKSPACE));
    expect(plan).toMatchObject({ sameWorkspace: false, counts: { copy: 6, insert: 0, reuse: 0 }, diverged: 0 });
    library.apply(plan);

    const result = imported(library, plan);
    // Nenhum ID de origem sobrevive, e o conjunto continua fechado no espaço de destino.
    const originIds = new Set(plan.items.map((item) => item.originId));
    for (const item of plan.items) expect(originIds.has(item.targetId)).toBe(false);
    expect(referenceProblems(result)).toEqual([]);
    expect(result.setlist.workspaceId).toBe(OTHER_WORKSPACE);
    const [arrangement] = result.arrangements as [Arrangement];
    expect(arrangement.songId).toBe(result.songs[0]!.id);
    expect(arrangement.themeRef).toEqual({ kind: 'workspace', themeId: result.themes[0]!.id });
    expect(arrangement.audioBindings.map((binding) => binding.assetId)).toEqual(result.assets.map((asset) => asset.id));
    expect(result.setlist.items.map((item) => item.arrangementId)).toEqual([arrangement.id, arrangement.id]);

    // Registro novo no destino: sem revisão de servidor, autoria de quem importou.
    expect(arrangement).toMatchObject({ serverRevision: null, basedOnSongRevision: null, createdBy: IMPORTER, updatedBy: IMPORTER, createdAt: NOW, deletedAt: null });
    expect(result.assets.map((asset) => [asset.remoteState, asset.storageKey, asset.workspaceId])).toEqual([
      ['local', null, OTHER_WORKSPACE],
      ['local', null, OTHER_WORKSPACE],
    ]);
    // O conteúdo autoral é o mesmo: títulos sem sufixo, IDs internos e marcações preservados.
    const source = input.documents.arrangements[0]!;
    expect(result.songs[0]!.title).toBe(input.documents.songs[0]!.title);
    expect(result.setlist.title).toBe(input.documents.setlist.title);
    expect(arrangement.occurrences).toEqual(source.occurrences);
    expect(arrangement.audioBindings[0]!.cues).toEqual(source.audioBindings[0]!.cues);
    expect(arrangement.selectedAudioBindingId).toBe(source.selectedAudioBindingId);
    expect(plan.media.map((item) => item.sha256).sort()).toEqual([input.playback.sha256, input.original.sha256].sort());
  });

  it('importação repetida em outro espaço reaproveita tudo: nenhuma escrita, nenhuma duplicata', async () => {
    const library = new MemoryLibrary();
    const pkg = await opened();
    const first = await planImport(pkg, target(library, OTHER_WORKSPACE));
    library.apply(first);
    const total = library.documents.size;

    const second = await planImport(pkg, target(library, OTHER_WORKSPACE));
    expect(second).toMatchObject({ counts: { copy: 0, insert: 0, reuse: 6 }, writes: [], diverged: 0, setlistId: first.setlistId });
    expect(second.items.map((item) => item.targetId)).toEqual(first.items.map((item) => item.targetId));
    library.apply(second);
    expect(library.documents.size).toBe(total);

    // Outro arquivo de pacote com o mesmo repertório (exportado de novo) também é reconhecido.
    const third = await planImport(await opened(), target(library, OTHER_WORKSPACE));
    expect(third.counts).toEqual({ copy: 0, insert: 0, reuse: 6 });
  });

  it('mesmo espaço, biblioteca vazia: os IDs são preservados', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    const plan = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    expect(plan).toMatchObject({ sameWorkspace: true, counts: { copy: 0, insert: 6, reuse: 0 }, setlistId: input.documents.setlist.id });
    library.apply(plan);
    const result = imported(library, plan);
    expect(result.songs[0]).toEqual({ ...input.documents.songs[0], serverRevision: null });
    // Autoria e datas originais ficam; só o que é do servidor é zerado.
    expect(result.arrangements[0]).toMatchObject({ id: input.documents.arrangements[0]!.id, createdBy: input.documents.arrangements[0]!.createdBy, serverRevision: null });
    expect(referenceProblems(result)).toEqual([]);
  });

  it('mesmo espaço, conteúdo igual ao local: nada é gravado, mesmo com revisões e carimbos diferentes', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    seed(library, input);
    library.put('song', { ...input.documents.songs[0]!, serverRevision: '7', updatedAt: '2026-10-07T00:00:00.000Z' });
    const plan = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    expect(plan).toMatchObject({ counts: { copy: 0, insert: 0, reuse: 6 }, writes: [] });
  });

  it('mesmo espaço com divergência: o registro local nunca é substituído; entra uma cópia identificada', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    seed(library, input);
    const localSong: Song = { ...input.documents.songs[0]!, title: 'Manhã de Gratidão — editada aqui', serverRevision: '4' };
    library.put('song', localSong);

    const plan = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    const byType = Object.fromEntries(plan.items.map((item) => [`${item.entityType}:${item.originId}`, item]));
    const songItem = byType[`song:${localSong.id}`]!;
    expect(songItem).toMatchObject({ action: 'copy', diverged: true });
    expect(songItem.targetId).not.toBe(localSong.id);
    // Arquivos e tema continuam os mesmos; arranjo e repertório acompanham o louvor copiado.
    expect(plan.items.filter((item) => item.entityType === 'asset' || item.entityType === 'theme').map((item) => item.action)).toEqual(['reuse', 'reuse', 'reuse']);
    expect(plan.items.filter((item) => item.entityType === 'arrangement' || item.entityType === 'setlist').map((item) => item.action)).toEqual(['copy', 'copy']);
    expect(plan.diverged).toBe(3);

    library.apply(plan);
    expect(library.find('song', localSong.id)).toEqual(localSong);
    expect(library.find('arrangement', input.documents.arrangements[0]!.id)).toEqual(input.documents.arrangements[0]);
    expect(library.find('setlist', input.documents.setlist.id)).toEqual(input.documents.setlist);
    const result = imported(library, plan);
    expect(result.songs[0]!.title).toBe(`Manhã de Gratidão${IMPORTED_SUFFIX}`);
    expect(result.setlist.title).toBe(`Culto de domingo${IMPORTED_SUFFIX}`);
    expect(result.arrangements[0]!.songId).toBe(songItem.targetId);
    expect(referenceProblems(result)).toEqual([]);

    // Repetir a importação reconhece as cópias já feitas.
    const again = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    expect(again).toMatchObject({ counts: { copy: 0, insert: 0, reuse: 6 }, writes: [], setlistId: plan.setlistId });
  });

  it('mesmo espaço, registro local excluído: o ID não é ressuscitado; entra uma cópia sem sufixo', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    seed(library, input);
    const deleted: Song = { ...input.documents.songs[0]!, deletedAt: '2026-10-05T18:00:00.000Z' };
    library.put('song', deleted);
    const plan = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    const songItem = plan.items.find((item) => item.entityType === 'song')!;
    expect(songItem.action).toBe('copy');
    expect(songItem.targetId).not.toBe(deleted.id);
    library.apply(plan);
    expect(library.find('song', deleted.id)).toEqual(deleted);
    expect((library.find('song', songItem.targetId) as Song).title).toBe('Manhã de Gratidão');
  });

  it('a cópia importada foi editada depois: nova importação cria outra cópia em vez de sobrescrever a edição', async () => {
    const library = new MemoryLibrary();
    const pkg = await opened();
    const first = await planImport(pkg, target(library, OTHER_WORKSPACE));
    library.apply(first);
    const songId = first.items.find((item) => item.entityType === 'song')!.targetId;
    const edited: Song = { ...(library.find('song', songId) as Song), rawLyrics: 'Letra reescrita no destino' };
    library.put('song', edited);

    const second = await planImport(pkg, target(library, OTHER_WORKSPACE));
    const item = second.items.find((entry) => entry.entityType === 'song')!;
    expect(item).toMatchObject({ action: 'copy', diverged: true });
    library.apply(second);
    expect(library.find('song', songId)).toEqual(edited);
    expect((library.find('song', item.targetId) as Song).title).toBe(`Manhã de Gratidão${IMPORTED_SUFFIX}`);
    // O mapeamento passa a apontar para a cópia mais recente: a terceira importação não cria mais nada.
    expect(library.mappings.get(originKey(ORIGIN_WORKSPACE, 'song', pkg.documents.songs[0]!.id))).toBe(item.targetId);
    expect((await planImport(pkg, target(library, OTHER_WORKSPACE))).writes).toEqual([]);
  });

  it('bytes já presentes no espaço de destino são reaproveitados pelo hash e pelo tipo de faixa', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    const existing: Asset = { ...input.playback, id: nextId(), workspaceId: OTHER_WORKSPACE, filename: 'ja-estava-aqui.mp3' };
    library.put('asset', existing);
    const plan = await planImport(await opened(input), target(library, OTHER_WORKSPACE));
    expect(plan.items.find((item) => item.originId === input.playback.id)).toMatchObject({ action: 'reuse', targetId: existing.id });
    // Mesmo hash com outro tipo de faixa não é o mesmo arquivo da biblioteca.
    expect(plan.items.find((item) => item.originId === input.original.id)).toMatchObject({ action: 'copy' });
    library.apply(plan);
    const arrangement = imported(library, plan).arrangements[0]!;
    expect(arrangement.audioBindings[0]!.assetId).toBe(existing.id);
    expect(library.list<Asset>('asset')).toHaveLength(2);
  });

  it('documento de outro espaço com o mesmo ID não é tratado como local', async () => {
    const input = sample();
    const library = new MemoryLibrary();
    // O banco de destino guarda, sob o mesmo ID, um registro que não é deste espaço.
    library.put('song', { ...input.documents.songs[0]!, workspaceId: OTHER_WORKSPACE });
    const plan = await planImport(await opened(input), target(library, ORIGIN_WORKSPACE));
    expect(plan.items.find((item) => item.entityType === 'song')).toMatchObject({ action: 'copy' });
  });
});
