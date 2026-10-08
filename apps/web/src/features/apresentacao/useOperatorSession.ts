'use client';

import { orderedSetlistItems, type Arrangement, type AudioKind, type Song, type Uuid } from '@louvorvisual/domain';
import { prepareSnapshot, type SessionCheckpoint, type SessionSnapshot, type SnapshotAudio, type SnapshotIssue, type SnapshotWarning } from '@louvorvisual/presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPresentationSession,
  endPresentationSession,
  findRecoverableSession,
  getAsset,
  getEntityState,
  getSetlist,
  getSong,
  listArrangements,
  preparedItem,
  readAssetBlob,
  readOperatorPreferences,
  readOutputRotation,
  resolveSetlist,
  saveCheckpoint,
  saveOperatorPreferences,
  saveOutputRotation,
  verifyAsset,
  type LocalSession,
  type OperatorPreferences,
  type PresentationSessionRow,
} from '@/local';
import { SESSION_LOCK } from '@/pwa/serviceWorker';
import { HtmlAudioTransport } from '../audio/htmlTransport';
import { SessionController } from './controller';

/** Um painel de operador por dispositivo: dois controladores disputariam a mesma saída. */
const CONTROLLER_LOCK = 'lv-presentation-controller';

/** Por que a faixa escolhida não pode tocar nesta sessão. */
export type AudioProblem = 'asset-missing' | 'missing' | 'corrupted' | 'unplayable';

/** Avisos da sessão além dos do snapshot. */
export type SessionWarning = SnapshotWarning | 'prepared-copy-outdated' | 'setlist-not-prepared' | 'audio-unavailable';

export type AudioChoice = { bindingId: Uuid; kind: AudioKind; filename: string | null };

/** De onde a sessão veio no repertório e para onde o operador pode seguir. Nada aqui inicia sozinho. */
export type SetlistPosition = {
  setlistId: Uuid;
  title: string;
  index: number;
  total: number;
  next: { itemId: Uuid; songId: Uuid; arrangementId: Uuid; title: string } | null;
};

export type OperatorSessionState =
  | { status: 'loading'; detail?: string }
  | { status: 'missing' }
  | { status: 'blocked' }
  | { status: 'invalid'; issues: SnapshotIssue[] }
  | { status: 'recoverable'; savedAt: string | null; title: string; recover: () => void; restart: () => void }
  | { status: 'audio-problem'; problem: AudioProblem; filename: string | null; continueWithoutAudio: () => void }
  | {
      status: 'active';
      controller: SessionController;
      row: PresentationSessionRow;
      warnings: SessionWarning[];
      recovered: boolean;
      /** Faixas que o arranjo oferece; a escolha só muda antes de iniciar. Vazio em cópia preparada. */
      audioChoices: AudioChoice[];
      chooseAudio: (bindingId: Uuid | null) => void;
      setlist: SetlistPosition | null;
      /** Encerra a sessão. `nextSessionId` avisa a janela de projeção de qual sessão vem a seguir. */
      end: (nextSessionId?: Uuid) => Promise<void>;
    };

/** Pede o lock exclusivo; devolve como soltá-lo, ou `null` se outro painel já o tem. */
async function acquireControllerLock(): Promise<(() => void) | null> {
  if (!navigator.locks) return () => {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const release = await new Promise<(() => void) | null>((resolve) => {
      void navigator.locks.request(CONTROLLER_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((held) => resolve(held));
      });
    });
    if (release) return release;
    // O painel anterior desta mesma aba pode estar terminando de soltar.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

type LoadedAudio = { ok: true; transport: HtmlAudioTransport } | { ok: false; problem: AudioProblem };

/**
 * Abre os bytes exatos que o snapshot referencia: confere presença, tamanho e
 * hash em fluxo e só então cria o player e espera os metadados. Qualquer falha
 * impede iniciar com a faixa.
 */
async function loadAudio(local: LocalSession, audio: SnapshotAudio, workspaceId: Uuid): Promise<LoadedAudio> {
  const identity = { workspaceId, sha256: audio.sha256, byteSize: audio.byteSize };
  const check = await verifyAsset(local.db, identity, new Date().toISOString());
  if (check !== 'ok') return { ok: false, problem: check };
  const blob = await readAssetBlob(local.db, workspaceId, audio.sha256);
  if (!blob) return { ok: false, problem: 'missing' };
  const transport = new HtmlAudioTransport(blob);
  try {
    await transport.ready();
    return { ok: true, transport };
  } catch {
    transport.dispose();
    return { ok: false, problem: 'unplayable' };
  }
}

export type OperatorSource = {
  songId: Uuid;
  arrangementId: Uuid | null;
  setlistId: Uuid | null;
  itemId: Uuid | null;
  /** ID combinado com a janela de projeção para a sessão nova (próximo louvor do repertório). */
  sessionHint: Uuid | null;
};

/**
 * Prepara ou recupera a sessão de um arranjo e mantém o controlador enquanto a
 * área do operador estiver aberta. Tudo vem do banco local; nada usa rede.
 */
export function useOperatorSession(local: LocalSession, source: OperatorSource): OperatorSessionState {
  const { songId, arrangementId, setlistId, itemId, sessionHint } = source;
  const [state, setState] = useState<OperatorSessionState>({ status: 'loading' });
  const cleanup = useRef<(() => void) | null>(null);

  const activate = useCallback(
    (options: {
      row: PresentationSessionRow;
      checkpoint: SessionCheckpoint | null;
      warnings: SessionWarning[];
      rotation: 0 | 90;
      preferences: OperatorPreferences;
      releaseLock: () => void;
      transport: HtmlAudioTransport | null;
      audioChoices: AudioChoice[];
      chooseAudio: (bindingId: Uuid | null) => void;
      setlist: SetlistPosition | null;
    }) => {
      const { row, releaseLock } = options;
      const controller = new SessionController({
        snapshot: row.snapshot,
        sessionId: row.id,
        checkpoint: options.checkpoint,
        rotation: options.rotation,
        mode: options.preferences.mode,
        appearance: options.preferences.appearance,
        generation: Date.now(),
        transport: options.transport,
        storage: {
          saveCheckpoint: (value) => saveCheckpoint(local.db, value, new Date().toISOString()),
          saveRotation: (value) => saveOutputRotation(local.db, value),
          savePreferences: (value) => saveOperatorPreferences(local.db, value),
        },
      });
      controller.start();
      // Enquanto a sessão existir, o aplicativo não troca de versão por baixo dela.
      let releaseSession = () => {};
      if (navigator.locks) {
        void navigator.locks.request(SESSION_LOCK, { mode: 'shared' }, () => new Promise<void>((resolve) => (releaseSession = resolve)));
      }
      const leave = () => {
        controller.dispose();
        releaseSession();
      };
      cleanup.current = () => {
        controller.flushCheckpoint();
        leave();
        releaseLock();
      };
      const end = async (nextSessionId?: Uuid) => {
        controller.announceEnd(nextSessionId);
        await controller.settled();
        await endPresentationSession(local.db, row.id);
        leave();
      };
      setState({
        status: 'active',
        controller,
        row,
        warnings: options.warnings,
        recovered: options.checkpoint !== null,
        audioChoices: options.audioChoices,
        // Trocar de faixa encerra esta sessão (ainda não iniciada) e prepara outra, com o mesmo lock.
        chooseAudio: (bindingId) => {
          cleanup.current = releaseLock;
          setState({ status: 'loading', detail: 'Preparando a faixa…' });
          void end().then(() => options.chooseAudio(bindingId));
        },
        setlist: options.setlist,
        end: async (nextSessionId) => {
          cleanup.current = null;
          await end(nextSessionId);
          releaseLock();
        },
      });
    },
    [local],
  );

  useEffect(() => {
    let current = true;
    void (async () => {
      const song = await getSong(local.db, songId);
      const arrangements = song ? await listArrangements(local.db, songId) : [];
      const arrangement = arrangements.find((item) => item.id === arrangementId) ?? arrangements[0];
      if (!current) return;
      if (!song || !arrangement) {
        setState({ status: 'missing' });
        return;
      }
      const releaseLock = await acquireControllerLock();
      if (!current) {
        releaseLock?.();
        return;
      }
      if (!releaseLock) {
        setState({ status: 'blocked' });
        return;
      }
      cleanup.current = releaseLock;
      const rotation = await readOutputRotation(local.db);
      const preferences = await readOperatorPreferences(local.db);
      const setlist = await setlistPosition(local, setlistId, itemId);
      const copy = setlistId && itemId ? await preparedItem(local.db, setlistId, itemId) : null;
      const fromSetlist: SessionWarning[] = copy ? (copy.newer ? ['prepared-copy-outdated'] : []) : setlist ? ['setlist-not-prepared'] : [];

      const audioChoices: AudioChoice[] = copy
        ? []
        : await Promise.all(arrangement.audioBindings.map(async (binding) => ({ bindingId: binding.id, kind: binding.kind, filename: (await getAsset(local.db, binding.assetId))?.filename ?? null })));

      /** Cria a sessão a partir de um snapshot pronto, com ou sem a faixa dele. */
      const open = async (snapshot: SessionSnapshot, baseArrangement: Arrangement, warnings: SessionWarning[], chooseAudio: (bindingId: Uuid | null) => void) => {
        let transport: HtmlAudioTransport | null = null;
        if (snapshot.audio) {
          setState({ status: 'loading', detail: 'Conferindo o arquivo de áudio…' });
          const loaded = await loadAudio(local, snapshot.audio, snapshot.workspaceId);
          if (!current) {
            if (loaded.ok) loaded.transport.dispose();
            return;
          }
          if (!loaded.ok) {
            // Arquivo ausente, corrompido ou ilegível: não inicia com a faixa.
            const withoutAudio: SessionSnapshot = { ...snapshot, audio: null };
            setState({
              status: 'audio-problem',
              problem: loaded.problem,
              filename: snapshot.audio.filename,
              continueWithoutAudio: () => void open(withoutAudio, baseArrangement, [...warnings, 'audio-unavailable'], chooseAudio),
            });
            return;
          }
          transport = loaded.transport;
        }
        const row = await createPresentationSession(local.db, snapshot, baseArrangement, snapshot.id);
        if (!current) {
          transport?.dispose();
          return;
        }
        activate({ row, checkpoint: null, warnings, rotation, preferences, releaseLock, transport, audioChoices, chooseAudio, setlist });
      };

      /** Prepara da biblioteca viva, com a faixa indicada (`undefined` = a selecionada no arranjo). */
      const prepare = async (bindingId?: Uuid | null) => {
        const live = await liveDocuments(local, song, arrangement);
        const wanted = bindingId === undefined ? live.arrangement.selectedAudioBindingId : bindingId;
        const binding = live.arrangement.audioBindings.find((item) => item.id === wanted) ?? null;
        const asset = binding ? await getAsset(local.db, binding.assetId) : null;
        const prepared = prepareSnapshot({
          id: sessionHint ?? crypto.randomUUID(),
          now: new Date().toISOString(),
          song: live.song,
          arrangement: live.arrangement,
          songGeneration: live.songGeneration,
          arrangementGeneration: live.arrangementGeneration,
          audio: binding && asset ? { binding, asset } : null,
        });
        if (!current) return;
        if (!prepared.ok) {
          setState({ status: 'invalid', issues: prepared.issues });
          return;
        }
        if (binding && !prepared.snapshot.audio) {
          // O registro do arquivo sumiu ou não tem duração conhecida: trata como arquivo ausente.
          setState({
            status: 'audio-problem',
            problem: 'asset-missing',
            filename: asset?.filename ?? null,
            continueWithoutAudio: () => void open(prepared.snapshot, live.arrangement, [...fromSetlist, ...prepared.warnings, 'audio-unavailable'], (next) => void prepare(next)),
          });
          return;
        }
        await open(prepared.snapshot, live.arrangement, [...fromSetlist, ...prepared.warnings], (next) => void prepare(next));
      };

      /** Usa a cópia preparada do repertório: a base é a revisão que foi conferida, não a biblioteca viva. */
      const start = () => (copy ? open({ ...copy.item.snapshot, id: sessionHint ?? crypto.randomUUID(), createdAt: new Date().toISOString() }, copy.item.baseArrangement, fromSetlist, () => undefined) : prepare());

      const found = await findRecoverableSession(local.db, arrangement.id);
      if (!current) return;
      // Só há o que recuperar se a sessão chegou a começar; uma sessão apenas
      // preparada é refeita com o conteúdo atual da biblioteca.
      if (found?.checkpoint && found.checkpoint.status !== 'ready') {
        const recover = async () => {
          const { session, checkpoint } = found;
          let transport: HtmlAudioTransport | null = null;
          const warnings: SessionWarning[] = [];
          if (session.snapshot.audio) {
            setState({ status: 'loading', detail: 'Conferindo o arquivo de áudio…' });
            const loaded = await loadAudio(local, session.snapshot.audio, session.snapshot.workspaceId);
            if (!current) {
              if (loaded.ok) loaded.transport.dispose();
              return;
            }
            // Sem a faixa, a sessão recuperada segue sem áudio, avisando o operador.
            if (loaded.ok) transport = loaded.transport;
            else warnings.push('audio-unavailable');
          }
          activate({ row: session, checkpoint, warnings, rotation, preferences, releaseLock, transport, audioChoices: [], chooseAudio: () => undefined, setlist });
        };
        setState({
          status: 'recoverable',
          savedAt: found.savedAt,
          title: found.session.snapshot.song.title,
          recover: () => void recover(),
          restart: () => void start(),
        });
        return;
      }
      await start();
    })();
    return () => {
      current = false;
      cleanup.current?.();
      cleanup.current = null;
    };
  }, [local, songId, arrangementId, setlistId, itemId, sessionHint, activate]);

  return state;
}

/** Documentos como estão agora na biblioteca, com as gerações locais. */
async function liveDocuments(local: LocalSession, song: Song, arrangement: Arrangement) {
  const [freshSong, freshArrangement, songState, arrangementState] = await Promise.all([
    local.db.songs.get(song.id),
    local.db.arrangements.get(arrangement.id),
    getEntityState(local.db, 'song', song.id),
    getEntityState(local.db, 'arrangement', arrangement.id),
  ]);
  return {
    song: freshSong ?? song,
    arrangement: freshArrangement ?? arrangement,
    songGeneration: songState?.localGeneration ?? 0,
    arrangementGeneration: arrangementState?.localGeneration ?? 0,
  };
}

async function setlistPosition(local: LocalSession, setlistId: Uuid | null, itemId: Uuid | null): Promise<SetlistPosition | null> {
  if (!setlistId || !itemId) return null;
  const setlist = await getSetlist(local.db, setlistId);
  if (!setlist) return null;
  const ordered = orderedSetlistItems(setlist.items);
  const index = ordered.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const following = ordered[index + 1];
  const [entry] = following ? await resolveSetlist(local.db, { items: [following] }) : [];
  return {
    setlistId,
    title: setlist.title,
    index,
    total: ordered.length,
    next: entry?.arrangement && entry.song ? { itemId: entry.item.id, songId: entry.song.id, arrangementId: entry.arrangement.id, title: entry.song.title } : null,
  };
}
