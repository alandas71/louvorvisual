'use client';

import type { OperatorCommand } from '@louvorvisual/presentation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, type PresentationRequest } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';
import { Dialog } from '@/ui/Dialog';
import { COMMAND_FAILURE_TEXT, NOTICE_TEXT, SNAPSHOT_ISSUE_TEXT, SNAPSHOT_WARNING_TEXT } from './labels';
import { LiveMenu } from './LiveMenu';
import { QuickControls } from './QuickControls';
import { openSession, recoverSession, type OpenedSession, type OpenFailure, type ProjectorSession } from './session';
import { SlideView } from './SlideView';

type Phase = { status: 'loading' } | { status: 'failed'; failure: OpenFailure } | { status: 'live'; opened: OpenedSession };

function failureText(failure: OpenFailure): string {
  if (failure.kind === 'not-found') return 'Este louvor não está mais neste aparelho.';
  if (failure.kind === 'snapshot') return failure.issues.map((issue) => SNAPSHOT_ISSUE_TEXT[issue]).join(' ');
  if (failure.kind === 'unrecoverable') return 'A sessão interrompida não pôde ser lida. Abra o louvor de novo pelo repertório.';
  return 'Não foi possível preparar a apresentação neste aparelho. Tente de novo.';
}

/**
 * Apresentação em tela única: motor, player e saída no mesmo lugar. Prepara a
 * sessão (ou recupera a interrompida) e só então mostra o palco; nada começa
 * sozinho.
 */
export function PresentationScreen({ request }: { request: PresentationRequest }) {
  const app = useApp();
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const latest = useRef(app);
  useEffect(() => {
    latest.current = app;
  });

  useEffect(() => {
    let current = true;
    let session: ProjectorSession | null = null;
    const { host, prefs } = latest.current;
    const common = { host, rotation: prefs.rotation, onRotation: (rotation: 0 | 90) => latest.current.updatePrefs({ rotation }) };
    const opening = request.kind === 'recover' ? recoverSession(common, request.session) : openSession(common, request.arrangementId, request.context);
    void opening.then((result) => {
      if (!current) {
        if (result.ok) result.opened.session.dispose();
        return;
      }
      // A sessão interrompida, recuperada ou substituída, deixa de ser oferecida no início.
      latest.current.setRecoverable(null);
      if (!result.ok) {
        setPhase({ status: 'failed', failure: result.failure });
        return;
      }
      session = result.opened.session;
      session.start();
      (window as unknown as { __lvSession: ProjectorSession }).__lvSession = session;
      setPhase({ status: 'live', opened: result.opened });
    });
    return () => {
      current = false;
      session?.dispose();
    };
  }, [request]);

  if (phase.status === 'live') return <LiveStage key={phase.opened.session.sessionId} opened={phase.opened} request={request} />;
  return <Pending phase={phase} />;
}

function Pending({ phase }: { phase: Exclude<Phase, { status: 'live' }> }) {
  const app = useApp();
  const ref = useFocusLayer<HTMLElement>({ name: 'presentation-pending', level: 0, repeat: 'directions', onBack: () => app.back() });
  return (
    <main className="stage" ref={ref} data-layer="presentation-pending" data-testid="presentation-pending">
      {phase.status === 'failed' && (
        <div className="scrim">
          <div className="dialog">
            <h2>Não foi possível abrir este louvor</h2>
            <p role="alert">{failureText(phase.failure)}</p>
            <div className="dialog-actions">
              <Action className="button" autoFocus testId="presentation-failed-back" onSelect={() => app.back()}>
                Voltar
              </Action>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

type Overlay = 'ready' | 'none' | 'controls' | 'menu';
const TOAST_MS = 1800;

function LiveStage({ opened, request }: { opened: OpenedSession; request: PresentationRequest }) {
  const app = useApp();
  const { session } = opened;
  const { view } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { controls } = view;
  const [overlay, setOverlay] = useState<Overlay>(view.state.status === 'ready' ? 'ready' : 'none');
  const [exiting, setExiting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(opened.recovered ? { text: 'Sessão recuperada em pausa', id: 0 } : null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const say = useCallback((text: string) => setToast({ text, id: Date.now() }), []);

  const dispatch = useCallback(
    (command: OperatorCommand) => {
      const result = session.execute(command);
      if (result.ok) return;
      if (result.reason === 'at-limit' && (command.type === 'next' || command.type === 'previous')) say(command.type === 'next' ? 'Último slide' : 'Primeiro slide');
      else say(COMMAND_FAILURE_TEXT[result.reason]);
    },
    [session, say],
  );

  const queue = request.kind === 'start' ? request.queue : [];
  const position = queue.findIndex((entry) => entry.itemId === opened.context.itemId);
  const nextSong = position >= 0 ? queue[position + 1] : undefined;
  const previousSong = position > 0 ? queue[position - 1] : undefined;

  /** Encerra de verdade: checkpoint final, sessão encerrada no host, player solto, tela preta até sair. */
  const end = useCallback(
    async (then: () => void) => {
      setLeaving(true);
      await session.settled().catch(() => undefined);
      session.dispose();
      await app.host.request('session.end', { sessionId: session.sessionId }).catch(() => undefined);
      then();
    },
    [app.host, session],
  );
  const leave = () => void end(() => app.back(opened.context.itemId ? `item:${opened.context.itemId}` : undefined));
  const changeSong = (entry: (typeof queue)[number]) =>
    void end(() => app.replace({ name: 'presentation', request: { kind: 'start', arrangementId: entry.arrangementId, context: { setlistId: opened.context.setlistId, itemId: entry.itemId }, queue } }));

  // Apresentação limpa: a área do slide tem o foco e as teclas são comandos diretos.
  const stage = useFocusLayer<HTMLElement>({
    name: 'slide',
    level: 0,
    repeat: 'none',
    onKey: (key) => {
      switch (key) {
        case 'left':
          dispatch({ type: 'previous' });
          return true;
        case 'right':
          dispatch({ type: 'next' });
          return true;
        case 'ok':
        case 'menu':
          setOverlay('menu');
          return true;
        case 'up':
        case 'down':
          setOverlay('controls');
          return true;
        case 'playPause':
          // Sem áudio nem tempo atual não há o que tocar ou pausar; a tecla não faz nada.
          if (controls.capabilities.transport) dispatch({ type: 'toggle' });
          return true;
        case 'back':
          setExiting(true);
          return true;
      }
    },
  });

  const { output } = view;
  const clean = overlay === 'none' && !exiting;
  const status = view.notice ? NOTICE_TEXT[view.notice] : view.state.status === 'paused' ? 'Em pausa · ↑ ou ↓ mostra os controles' : view.state.status === 'finished' ? 'Fim dos slides' : null;
  const facts = [
    `${controls.total} ${controls.total === 1 ? 'slide' : 'slides'}`,
    controls.mode === 'automatic' ? 'avanço automático' : 'avanço manual',
    ...(controls.audio ? [`${controls.audio.kind === 'playback' ? 'playback' : 'áudio original'} ${controls.audio.policy === 'linked' ? 'vinculado aos slides' : 'independente'}`] : []),
  ];

  return (
    <main
      className="stage"
      ref={stage}
      data-layer="slide"
      data-testid="stage"
      data-overlay={exiting ? 'exit' : overlay}
      data-status={view.state.status}
      data-mode={controls.mode}
      data-slide-index={controls.index}
      data-slide-total={controls.total}
      data-font-size={controls.appearance.fontSizePx}
      data-theme={controls.appearance.themePresetId ?? ''}
    >
      {leaving ? (
        <div className="stage-slide" style={{ background: '#000' }} />
      ) : (
        <SlideView text={output.slide.text} style={output.slide.style} fontId={output.slide.fontId} visualMode={output.visualMode} rotation={view.rotation} />
      )}
      <div className="stage-focus" tabIndex={-1} data-focusable="" data-autofocus="" data-testid="slide-focus" aria-label={`Slide ${controls.index + 1} de ${controls.total}`} />

      {clean && status && !leaving && (
        <p className="pill pill-top" data-testid="stage-status" role="status">
          {status}
        </p>
      )}
      {toast && !leaving && (
        <p className="pill" data-testid="stage-toast" role="status">
          {toast.text}
        </p>
      )}

      {overlay === 'controls' && !leaving && <QuickControls controls={controls} remaining={() => session.remainingMs()} dispatch={dispatch} onMenu={() => setOverlay('menu')} onClose={() => setOverlay('none')} />}

      {overlay === 'menu' && !leaving && (
        <LiveMenu
          controls={controls}
          dispatch={dispatch}
          onClose={() => setOverlay('none')}
          onExit={() => setExiting(true)}
          onNextSong={nextSong ? () => changeSong(nextSong) : undefined}
          onPreviousSong={previousSong ? () => changeSong(previousSong) : undefined}
          nextSongTitle={nextSong?.title}
          previousSongTitle={previousSong?.title}
        />
      )}

      {overlay === 'ready' && !leaving && (
        <Dialog
          name="ready"
          testId="ready-dialog"
          title={opened.title}
          onBack={leave}
          actions={
            <>
              <Action
                className="button"
                autoFocus
                testId="ready-start"
                onSelect={() => {
                  dispatch({ type: 'start' });
                  setOverlay('none');
                }}
              >
                Iniciar
              </Action>
              <Action className="button" testId="ready-back" onSelect={leave}>
                Voltar
              </Action>
            </>
          }
        >
          <p data-testid="ready-facts">
            {opened.artist ? `${opened.artist} · ` : ''}
            {facts.join(' · ')}
          </p>
          {opened.audioUnavailable && (
            <p className="alert" data-testid="ready-audio-missing">
              A faixa de áudio deste louvor não está neste aparelho. Iniciar apresenta sem áudio.
            </p>
          )}
          {opened.warnings.map((warning) => (
            <p key={warning} className="alert">
              {SNAPSHOT_WARNING_TEXT[warning]}
            </p>
          ))}
          <p>Depois de iniciar: ← → trocam o slide · OK abre os ajustes · ↑ ↓ mostram os controles · Voltar encerra.</p>
        </Dialog>
      )}

      {exiting && !leaving && (
        <Dialog
          name="exit"
          testId="exit-dialog"
          title="Encerrar a apresentação?"
          onBack={() => setExiting(false)}
          actions={
            <>
              <Action className="button" autoFocus testId="exit-continue" onSelect={() => setExiting(false)}>
                Continuar apresentação
              </Action>
              <Action className="button" testId="exit-end" onSelect={leave}>
                Encerrar
              </Action>
            </>
          }
        />
      )}
    </main>
  );
}
