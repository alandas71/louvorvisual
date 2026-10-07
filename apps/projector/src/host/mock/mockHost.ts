import {
  BRIDGE_VERSION,
  DEFAULT_PROJECTOR_PREFS,
  hostMethods,
  hostRequestSchema,
  type AccountStatus,
  type HostErrorCode,
  type HostEventName,
  type HostEventPayload,
  type HostMethod,
  type HostPort,
  type HostResult,
  type ImportRejection,
  type ProjectorPrefs,
  type RecoverableSession,
  type RemoteKey,
  type SetlistEntry,
  type SetlistSummary,
  type SongSummary,
} from '@louvorvisual/contracts';
import { FONT_PACK_VERSION, orderedSetlistItems, type Arrangement, type Setlist } from '@louvorvisual/domain';
import { buildLibrary, importedSetlist, type MockLibrary } from './fixtures';

// Host simulado: faz, dentro do navegador, o papel do aplicativo Android. Fala
// com o bundle só pela ponte, com as mesmas mensagens em texto — a interface
// não sabe que não há aparelho. Guarda sessão e preferências em sessionStorage
// para que "fechar e reabrir" possa ser ensaiado com uma recarga da página.
// O teclado do computador entra por aqui como se fosse o controle, pelo mesmo
// evento `remote.key` que a Activity envia: há um único caminho de teclas.

const STORAGE_KEY = 'lv-mock-host';

type Persisted = { prefs: ProjectorPrefs; session: RecoverableSession | null; imported: boolean; signedIn: boolean };

class MockFailure extends Error {
  constructor(readonly code: HostErrorCode) {
    super(code);
  }
}

const KEYBOARD: Record<string, RemoteKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'ok',
  Escape: 'back',
  Backspace: 'back',
  m: 'menu',
  ContextMenu: 'menu',
  ' ': 'playPause',
  MediaPlayPause: 'playPause',
};

export type MockControls = {
  /** Envia uma tecla como o host enviaria; sem `seq`, usa a próxima da sequência. */
  key(key: RemoteKey, action?: 'down' | 'up', repeat?: number, seq?: number): number;
  press(key: RemoteKey): void;
  /** Entrega um texto qualquer ao bundle, como se viesse do host. */
  raw(text: string): void;
  emit<E extends HostEventName>(event: E, payload: HostEventPayload<E>): void;
  /** Pedidos recebidos do bundle, na ordem. */
  requests: { method: HostMethod; params: unknown }[];
  failNext(method: HostMethod, code: HostErrorCode): void;
  /** O que o próximo "Escolher arquivo" devolve. */
  nextPick: 'ready' | 'cancelled' | ImportRejection;
  setOnline(online: boolean): void;
  audio(): { loaded: boolean; playing: boolean; positionMs: number; volume: number };
  /** Pausa vinda de fora do aplicativo (foco de áudio, tecla de mídia). */
  interruptAudio(): void;
  keepAwake: boolean;
  exited: boolean;
};

function load(): Persisted {
  const fallback: Persisted = { prefs: { ...DEFAULT_PROJECTOR_PREFS }, session: null, imported: false, signedIn: false };
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? { ...fallback, ...(JSON.parse(stored) as Partial<Persisted>) } : fallback;
  } catch {
    return fallback;
  }
}

export function createMockHost(query: URLSearchParams): { port: HostPort; controls: MockControls } {
  const state = load();
  const save = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Sem armazenamento, o estado vale só até a recarga.
    }
  };
  const library: MockLibrary = buildLibrary({ empty: query.get('mock') === 'empty' });
  if (state.imported) importedSetlist(library);
  const latency = Number(query.get('latency') ?? '0') || 0;
  const epoch = `mock-${Date.now().toString(36)}`;
  let seq = 0;
  let online = query.get('mock') !== 'offline';
  let syncing = false;
  const failures = new Map<HostMethod, HostErrorCode>();
  const imports = new Map<string, true>();

  const port: HostPort = { postMessage: (message) => void receive(message), onmessage: null };
  const deliver = (message: unknown) => port.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  const emit = <E extends HostEventName>(event: E, payload: HostEventPayload<E>) => deliver({ v: BRIDGE_VERSION, kind: 'event', event, payload });

  // ── player simulado: a posição anda com o relógio, sem som ──
  const player = { loaded: false, durationMs: 0, base: 0, anchor: null as number | null, volume: 1, timer: null as number | null };
  const position = () => Math.min(player.durationMs, player.base + (player.anchor === null ? 0 : performance.now() - player.anchor));
  const stopPlayer = () => {
    player.base = position();
    player.anchor = null;
    if (player.timer !== null) window.clearInterval(player.timer);
    player.timer = null;
  };
  const tick = () => {
    if (player.anchor === null) return;
    if (position() >= player.durationMs) {
      stopPlayer();
      emit('audio.state', { type: 'ended', positionMs: player.durationMs });
      return;
    }
    emit('audio.state', { type: 'time', positionMs: position() });
  };

  const account = (): AccountStatus => ({
    profile: state.signedIn ? 'team' : 'personal',
    teamName: state.signedIn ? 'Equipe de Louvor (demonstração)' : null,
    signedIn: state.signedIn,
    online,
    sync: { state: !state.signedIn ? 'disabled' : syncing ? 'syncing' : 'idle', pending: 0, conflicts: 0, lastSyncedAt: state.signedIn ? '2026-10-06T11:30:00.000Z' : null },
  });

  const audioOf = (arrangement: Arrangement): SongSummary['audio'] => {
    const binding = arrangement.audioBindings.find((item) => item.id === arrangement.selectedAudioBindingId);
    if (!binding) return 'none';
    return library.missingAssets.has(binding.assetId) || !library.assets.has(binding.assetId) ? 'missing' : 'ready';
  };
  const summary = (arrangement: Arrangement): SongSummary => {
    const song = library.songs.get(arrangement.songId);
    return { songId: arrangement.songId, arrangementId: arrangement.id, title: song?.title ?? '', artist: song?.artist ?? null, slideCount: arrangement.occurrences.length, audio: audioOf(arrangement) };
  };
  const setlistSummary = (setlist: Setlist): SetlistSummary => ({ setlistId: setlist.id, title: setlist.title, serviceDate: setlist.serviceDate, itemCount: setlist.items.length });
  const page = <T,>(all: T[], cursor: string | null, limit: number) => {
    const start = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new MockFailure('invalid-request');
    const end = start + limit;
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  };

  const handlers: { [M in HostMethod]: (params: never) => HostResult<M> | Promise<HostResult<M>> } = {
    'host.info': () => ({ bridgeVersion: BRIDGE_VERSION, host: 'mock', appVersion: '0.2.0-simulado', fontPackVersion: FONT_PACK_VERSION }),
    'host.setKeepAwake': ({ on }: { on: boolean }) => {
      controls.keepAwake = on;
      return {};
    },
    'host.exit': () => {
      controls.exited = true;
      return {};
    },
    'prefs.get': () => ({ prefs: state.prefs }),
    'prefs.set': ({ prefs }: { prefs: Partial<ProjectorPrefs> }) => {
      state.prefs = { ...state.prefs, ...prefs };
      save();
      return { prefs: state.prefs };
    },
    'library.listSetlists': ({ cursor, limit }: { cursor: string | null; limit: number }) => page(library.setlists.map(setlistSummary), cursor, limit),
    'library.getSetlist': ({ setlistId }: { setlistId: string }) => {
      const setlist = library.setlists.find((item) => item.id === setlistId);
      if (!setlist) throw new MockFailure('not-found');
      const items: SetlistEntry[] = orderedSetlistItems(setlist.items).flatMap((item) => {
        const arrangement = library.arrangements.get(item.arrangementId);
        // As notas do item ficam no host: o contrato não tem campo para elas.
        return arrangement ? [{ ...summary(arrangement), itemId: item.id }] : [];
      });
      return { setlist: setlistSummary(setlist), items };
    },
    'library.listSongs': ({ cursor, limit }: { cursor: string | null; limit: number }) =>
      page(
        [...library.arrangements.values()].map(summary).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')),
        cursor,
        limit,
      ),
    'library.getPresentable': ({ arrangementId }: { arrangementId: string }) => {
      const arrangement = library.arrangements.get(arrangementId);
      const song = arrangement && library.songs.get(arrangement.songId);
      if (!arrangement || !song) throw new MockFailure('not-found');
      const binding = arrangement.audioBindings.find((item) => item.id === arrangement.selectedAudioBindingId);
      const asset = binding ? library.assets.get(binding.assetId) : undefined;
      const missing = Boolean(binding) && (!asset || library.missingAssets.has(asset.id));
      return { song, arrangement, songGeneration: 1, arrangementGeneration: 1, audio: binding && asset && !missing ? { binding, asset } : null, audioMissing: missing };
    },
    'session.create': ({ sessionId, snapshot, context }: { sessionId: string; snapshot: Record<string, unknown>; context: RecoverableSession['context'] }) => {
      state.session = { sessionId, snapshot, checkpoint: null, savedAt: null, context };
      save();
      return {};
    },
    'session.saveCheckpoint': ({ sessionId, checkpoint }: { sessionId: string; checkpoint: Record<string, unknown> }) => {
      // Gravação atrasada de uma sessão já encerrada não a ressuscita.
      if (state.session?.sessionId !== sessionId) throw new MockFailure('not-found');
      const savedAt = new Date().toISOString();
      state.session = { ...state.session, checkpoint, savedAt };
      save();
      return { savedAt };
    },
    'session.findRecoverable': () => ({ session: state.session }),
    'session.end': ({ sessionId }: { sessionId: string }) => {
      if (state.session?.sessionId === sessionId) state.session = null;
      save();
      return {};
    },
    'files.pickPackage': async () => {
      const pick = controls.nextPick;
      if (pick === 'cancelled') return { status: 'cancelled' as const };
      const totalBytes = 5_242_880;
      for (const [phase, loadedBytes] of [['copying', totalBytes / 2], ['copying', totalBytes], ['verifying', totalBytes]] as const) {
        emit('files.progress', { phase, loadedBytes, totalBytes });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      if (pick !== 'ready') return { status: 'rejected' as const, code: pick };
      const importId = `imp-${imports.size + 1}`;
      imports.set(importId, true);
      const already = state.imported;
      return {
        status: 'ready' as const,
        importId,
        fileName: 'repertorio-culto-de-quarta-20261006.louvorvisual.zip',
        preview: { title: 'Culto de quarta', sameWorkspace: false, songs: 1, newDocuments: already ? 0 : 3, existingDocuments: already ? 3 : 0, copiedDocuments: 0, mediaBytes: 0, newMediaBytes: 0, omittedMedia: 1 },
      };
    },
    'files.applyImport': ({ importId }: { importId: string }) => {
      if (!imports.delete(importId)) throw new MockFailure('not-found');
      const existing = library.setlists.find((item) => item.title === 'Culto de quarta');
      const setlist = existing ?? importedSetlist(library);
      state.imported = true;
      save();
      return { setlistId: setlist.id };
    },
    'files.discardImport': ({ importId }: { importId: string }) => {
      imports.delete(importId);
      return {};
    },
    'audio.load': ({ assetId }: { assetId: string }) => {
      const asset = library.assets.get(assetId);
      if (!asset || library.missingAssets.has(assetId) || asset.durationMs === null) throw new MockFailure('unavailable');
      stopPlayer();
      Object.assign(player, { loaded: true, durationMs: asset.durationMs, base: 0, anchor: null });
      return { durationMs: asset.durationMs };
    },
    'audio.play': () => {
      if (!player.loaded) throw new MockFailure('unavailable');
      if (player.anchor === null) {
        player.anchor = performance.now();
        player.timer = window.setInterval(tick, 200);
        window.setTimeout(() => player.anchor !== null && emit('audio.state', { type: 'playing', positionMs: position() }), 0);
      }
      return {};
    },
    'audio.pause': () => {
      stopPlayer();
      window.setTimeout(() => emit('audio.state', { type: 'paused', positionMs: player.base, external: false }), 0);
      return { positionMs: player.base };
    },
    'audio.seek': ({ positionMs }: { positionMs: number }) => {
      if (!player.loaded) throw new MockFailure('unavailable');
      const playing = player.anchor !== null;
      player.base = Math.min(player.durationMs, positionMs);
      player.anchor = playing ? performance.now() : null;
      return { positionMs: player.base };
    },
    'audio.setVolume': ({ volume }: { volume: number }) => {
      player.volume = volume;
      return {};
    },
    'audio.release': () => {
      stopPlayer();
      Object.assign(player, { loaded: false, durationMs: 0, base: 0 });
      return {};
    },
    'account.status': () => account(),
    'account.signIn': () => {
      if (!online) return { status: 'offline' as const };
      // No aparelho, aqui abre a tela nativa de entrada; nada de credencial passa pelo bundle.
      state.signedIn = true;
      save();
      emit('account.changed', account());
      return { status: 'signed-in' as const };
    },
    'account.signOut': () => {
      state.signedIn = false;
      save();
      emit('account.changed', account());
      return {};
    },
    'account.syncNow': () => {
      if (!state.signedIn || !online) return { started: false };
      syncing = true;
      emit('account.changed', account());
      window.setTimeout(() => {
        syncing = false;
        emit('account.changed', account());
      }, 300);
      return { started: true };
    },
  };

  async function receive(message: string): Promise<void> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(message);
    } catch {
      return;
    }
    // O host valida o envelope e os parâmetros como o Kotlin fará: o que não passa não é atendido.
    const request = hostRequestSchema.safeParse(raw);
    if (!request.success) return;
    const { id, method } = request.data;
    const fail = (code: HostErrorCode) => deliver({ v: BRIDGE_VERSION, kind: 'error', id, error: { code, message: '' } });
    const params = hostMethods[method].params.safeParse(request.data.params);
    controls.requests.push({ method, params: request.data.params });
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    else await Promise.resolve();
    if (!params.success) return fail('invalid-request');
    const forced = failures.get(method);
    if (forced) {
      failures.delete(method);
      return fail(forced);
    }
    try {
      const result = await (handlers[method] as (params: unknown) => unknown)(params.data);
      deliver({ v: BRIDGE_VERSION, kind: 'response', id, ok: true, result });
    } catch (error) {
      fail(error instanceof MockFailure ? error.code : 'failed');
    }
  }

  const controls: MockControls = {
    key(key, action = 'down', repeat = 0, sequence) {
      const used = sequence ?? seq++;
      if (sequence !== undefined) seq = Math.max(seq, sequence + 1);
      emit('remote.key', { epoch, seq: used, key, action, repeat });
      return used;
    },
    press(key) {
      controls.key(key, 'down');
      controls.key(key, 'up');
    },
    raw: (text) => deliver(text),
    emit,
    requests: [],
    failNext: (method, code) => void failures.set(method, code),
    nextPick: 'ready',
    setOnline(value) {
      online = value;
      emit('account.changed', account());
    },
    audio: () => ({ loaded: player.loaded, playing: player.anchor !== null, positionMs: position(), volume: player.volume }),
    interruptAudio() {
      if (player.anchor === null) return;
      stopPlayer();
      emit('audio.state', { type: 'paused', positionMs: player.base, external: true });
    },
    keepAwake: false,
    exited: false,
  };

  // Teclado do computador → mesma mensagem do controle. O padrão do navegador é
  // cancelado: Enter não "clica" o botão focado por conta própria, e as setas
  // não rolam a página. Quem age é só o comando que volta pela ponte.
  const repeats = new Map<RemoteKey, number>();
  window.addEventListener(
    'keydown',
    (event) => {
      const key = KEYBOARD[event.key];
      if (!key || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const repeat = event.repeat ? (repeats.get(key) ?? 0) + 1 : 0;
      repeats.set(key, repeat);
      controls.key(key, 'down', repeat);
    },
    { capture: true },
  );
  window.addEventListener(
    'keyup',
    (event) => {
      const key = KEYBOARD[event.key];
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      repeats.delete(key);
      controls.key(key, 'up');
    },
    { capture: true },
  );
  document.addEventListener('visibilitychange', () => emit('host.lifecycle', { state: document.visibilityState === 'hidden' ? 'background' : 'foreground' }));

  return { port, controls };
}
