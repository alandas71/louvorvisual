import {
  addSetlistItem,
  createArrangement,
  createSetlist,
  createSong,
  deriveCues,
  type Arrangement,
  type Asset,
  type AuthoringContext,
  type Setlist,
  type Song,
} from '@louvorvisual/domain';

// Biblioteca de demonstração do host simulado. Todas as letras foram escritas
// para este projeto; nenhum texto ou áudio de terceiros.

const WORKSPACE = '00000000-0000-4000-8000-00000000aaaa';
const USER = '00000000-0000-4000-8000-00000000bbbb';
const NOW = '2026-10-06T12:00:00.000Z';

export type MockLibrary = {
  workspaceId: string;
  songs: Map<string, Song>;
  arrangements: Map<string, Arrangement>;
  assets: Map<string, Asset>;
  setlists: Setlist[];
  /** Arquivos cujo áudio "não está neste aparelho". */
  missingAssets: Set<string>;
};

const LYRICS = {
  uniao: `[Estrofe 1]
Com esperança eu vou caminhar
E com minha voz agradecer

[Refrão]
Hoje cantamos em união
Com alegria no coração

[Estrofe 2]
Cada manhã é um novo começar
Juntos seguimos a cantar

[Refrão]
Hoje cantamos em união
Com alegria no coração`,
  manha: `[Estrofe 1]
A manhã chegou sobre o quintal
E a luz entrou pelo portão

[Refrão]
Gratidão, gratidão
Pelo dia que nasceu

[Estrofe 2]
O pão na mesa, a casa em paz
E o riso que voltou`,
  colheita: `[Estrofe 1]
Plantei no tempo de esperar
Reguei no tempo de calar

[Refrão]
Chegou o dia da colheita
Chegou o tempo de cantar

[Ponte]
Nada do que foi semeado se perdeu`,
  caminho: `[Estrofe 1]
Há uma luz no meu caminho
Que não me deixa tropeçar

[Refrão]
Eu sigo, eu sigo
Sem medo de errar`,
};

/** IDs previsíveis e válidos: o mesmo conteúdo a cada carga. */
function idFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
}

export function buildLibrary(options: { empty?: boolean } = {}): MockLibrary {
  const context: AuthoringContext = { workspaceId: WORKSPACE, userId: USER, now: NOW, newId: idFactory() };
  const library: MockLibrary = { workspaceId: WORKSPACE, songs: new Map(), arrangements: new Map(), assets: new Map(), setlists: [], missingAssets: new Set() };
  if (options.empty) return library;

  const add = (title: string, artist: string, rawLyrics: string, change: (arrangement: Arrangement) => Arrangement = (value) => value) => {
    // A nota é privada do operador: existe aqui para os testes provarem que não aparece na tela.
    const { song, parsed } = createSong({ title, artist, rawLyrics, notes: 'NOTA-PRIVADA: entrada só com violão' }, context);
    const arrangement = change(createArrangement(song, parsed, context, { themeRef: { kind: 'builtin', presetId: 'grafite' } }));
    library.songs.set(song.id, song);
    library.arrangements.set(arrangement.id, arrangement);
    return arrangement;
  };

  const audio = (filename: string, durationMs: number, seed: string): Asset => {
    const asset: Asset = {
      id: context.newId(),
      workspaceId: WORKSPACE,
      sha256: seed.repeat(64).slice(0, 64),
      filename,
      mimeType: 'audio/mpeg',
      byteSize: 4_000_000,
      audioKind: 'playback',
      durationMs,
      remoteState: 'local',
      storageKey: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    library.assets.set(asset.id, asset);
    return asset;
  };

  const withAudio = (arrangement: Arrangement, asset: Asset, policy: 'independent' | 'linked'): Arrangement => {
    const bindingId = context.newId();
    const cues = policy === 'linked' ? (deriveCues(arrangement.occurrences, 0) ?? []) : [];
    return { ...arrangement, audioBindings: [{ id: bindingId, assetId: asset.id, kind: 'playback', policy, volume: 0.8, offsetMs: 0, cuesVersion: policy === 'linked' ? 1 : 0, cues }], selectedAudioBindingId: bindingId };
  };

  // Manual, sem tempo e sem áudio: nada de relógio nem play/pause.
  const uniao = add('Em União', 'Coral da Vila', LYRICS.uniao);
  // Automático: o primeiro e o terceiro slide têm tempo; o segundo espera o operador.
  const manha = add('Manhã de Gratidão', 'Grupo Alvorada', LYRICS.manha, (arrangement) => ({
    ...arrangement,
    defaultMode: 'automatic',
    occurrences: arrangement.occurrences.map((occurrence, index) => ({ ...occurrence, durationMs: index === 1 ? null : 4000 })),
  }));
  // Manual com playback independente.
  const colheita = add('Canção da Colheita', 'Coral da Vila', LYRICS.colheita, (arrangement) => withAudio(arrangement, audio('playback-colheita.mp3', 60_000, 'c'), 'independent'));
  // Faixa escolhida cujo arquivo não está neste aparelho.
  const caminho = add('Luz no Caminho', 'Grupo Alvorada', LYRICS.caminho, (arrangement) => {
    const asset = audio('playback-caminho.mp3', 45_000, 'd');
    library.missingAssets.add(asset.id);
    return withAudio(arrangement, asset, 'independent');
  });
  // Volume para exercitar paginação e tecla mantida em lista.
  for (let number = 1; number <= 36; number += 1) add(`Cântico ${String(number).padStart(2, '0')}`, 'Coletânea de ensaio', `[Estrofe 1]\nPrimeira linha do cântico ${number}\nSegunda linha do cântico ${number}\n\n[Refrão]\nRefrão do cântico ${number}`);

  const setlist = (title: string, serviceDate: string, arrangements: Arrangement[]) => {
    let value: Setlist = createSetlist({ title, serviceDate, timeZone: 'America/Sao_Paulo', notes: 'NOTA-PRIVADA: avisar o pastor' }, context);
    for (const arrangement of arrangements) value = { ...value, items: addSetlistItem(value.items, arrangement.id, context.newId).map((item) => ({ ...item, notes: 'NOTA-PRIVADA: tom abaixo' })) };
    library.setlists.push(value);
  };
  setlist('Culto de domingo', '2026-10-11', [uniao, manha, colheita, caminho]);
  setlist('Ensaio de quinta', '2026-10-08', [manha, uniao]);
  for (let number = 1; number <= 14; number += 1) setlist(`Culto arquivado ${String(number).padStart(2, '0')}`, `2026-09-${String(number).padStart(2, '0')}`, [uniao]);
  return library;
}

/** Repertório que o "pendrive" do host simulado entrega em Importar pacote. */
export function importedSetlist(library: MockLibrary): Setlist {
  const context: AuthoringContext = { workspaceId: library.workspaceId, userId: USER, now: NOW, newId: (() => { let counter = 0xf000; return () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, '0')}`; })() };
  const { song, parsed } = createSong({ title: 'Cântico do Pendrive', artist: 'Equipe visitante', rawLyrics: '[Estrofe 1]\nChegou por um pacote\nE ficou neste aparelho\n\n[Refrão]\nMesmo sem internet' }, context);
  const arrangement = createArrangement(song, parsed, context, { themeRef: { kind: 'builtin', presetId: 'azul-noturno' } });
  library.songs.set(song.id, song);
  library.arrangements.set(arrangement.id, arrangement);
  let value = createSetlist({ title: 'Culto de quarta', serviceDate: '2026-10-14', timeZone: 'America/Sao_Paulo' }, context);
  value = { ...value, items: addSetlistItem(value.items, arrangement.id, context.newId) };
  library.setlists.unshift(value);
  return value;
}
