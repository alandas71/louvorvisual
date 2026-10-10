'use client';

import { HEARTBEAT_INTERVAL_MS, ProjectionReceiver, shortcutCommand, type OperatorCommand, type ReceiverState, type ResolvedSlide } from '@louvorvisual/presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SlideView } from '@/components/SlideView';
import { buttonClass } from '@/components/ui/buttonStyles';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { useFontFace } from '@/presentation/measure';
import { ServiceWorkerRegistration } from '@/pwa/ServiceWorkerRegistration';
import { openLocalChannel, type LocalChannel } from '../apresentacao/channel';
import { InteractiveStage } from '../apresentacao/InteractiveStage';

/** Preferência desta janela/dispositivo; não pertence ao tema nem à sessão. */
const CONTROLS_PREFERENCE = 'lv:output:public:show-controls';
/** "Armada" vale para esta aba, em qualquer sessão: a janela já está no projetor ao passar ao próximo louvor. */
const ARMED_KEY = 'lv:output:public:armed';

function readFlag(storage: 'localStorage' | 'sessionStorage', key: string): boolean {
  try {
    return window[storage].getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(storage: 'localStorage' | 'sessionStorage', key: string, value: boolean): void {
  try {
    if (value) window[storage].setItem(key, '1');
    else window[storage].removeItem(key);
  } catch {
    // Sem armazenamento, a preferência vale só enquanto a janela estiver aberta.
  }
}

/**
 * Janela pública. Não tem motor, relógio nem áudio: mostra o último estado
 * visual confirmado pelo controlador e, se habilitado, encaminha comandos a
 * ele. Limpa por padrão. Enquanto aberta, impede a troca de versão do aplicativo.
 */
export function ProjectionShell() {
  const sessionId = useLocalQuery().get('session');
  return (
    <>
      <ServiceWorkerRegistration holdsSession />
      {sessionId ? <PublicOutput key={sessionId} sessionId={sessionId} /> : <WaitingScreen />}
    </>
  );
}

/** Confere a face que esta janela está desenhando; o resultado vai para o operador, nunca para a tela. */
function FontReport({ slide, onResult }: { slide: ResolvedSlide; onResult: (missing: boolean) => void }) {
  const status = useFontFace(slide.fontId, slide.style.fontWeight);
  useEffect(() => {
    if (status !== 'loading') onResult(status === 'missing');
  }, [status, onResult]);
  return null;
}

function WaitingScreen() {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-black p-8 text-center text-muted" data-testid="public-output" data-status="no-session">
      <p>Abra a projeção pelo painel do operador, em &ldquo;Abrir janela de projeção&rdquo;.</p>
    </main>
  );
}

function PublicOutput({ sessionId }: { sessionId: string }) {
  const receiver = useRef<ProjectionReceiver | null>(null);
  const channel = useRef<LocalChannel | null>(null);
  const [state, setState] = useState<ReceiverState>({ status: 'waiting', generation: null, info: null, visual: null });
  const [controllerLost, setControllerLost] = useState(false);
  const [armed, setArmed] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);

  useEffect(() => {
    // O que foi escolhido nesta janela vale de novo depois de recarregar.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do armazenamento do navegador, indisponível no HTML estático
    setArmed(readFlag('sessionStorage', ARMED_KEY));
    setShowControls(readFlag('localStorage', CONTROLS_PREFERENCE));
  }, [sessionId]);

  useEffect(() => {
    const current = new ProjectionReceiver(sessionId, crypto.randomUUID());
    receiver.current = current;
    const opened = openLocalChannel((message) => {
      const { changed, reply, handoffTo } = current.receive(message, performance.now());
      if (handoffTo) {
        // Próximo louvor do repertório: esta janela passa a esperar a sessão nova, em preto.
        setLocalQuery({ session: handoffTo });
        return;
      }
      // A confirmação da sequência sai depois de a imagem ser aplicada (efeito abaixo).
      for (const item of reply) if (item.type !== 'STATE_ACK') opened?.post(item);
      if (changed) setState(current.getState());
      setControllerLost(false);
    });
    channel.current = opened;
    opened?.post(current.hello());
    const timer = window.setInterval(() => {
      const lost = current.controllerLost(performance.now());
      setControllerLost(lost);
      // Sem controlador confirmado, continua pedindo o estado: é assim que reconecta.
      if (current.getState().status !== 'live' || lost) opened?.post(current.hello());
      const beat = current.heartbeat();
      if (beat) opened?.post(beat);
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      opened?.close();
      channel.current = null;
      receiver.current = null;
    };
  }, [sessionId]);

  // STATE_ACK: confirma a sequência que esta janela acabou de desenhar.
  const sequence = state.visual?.sequenceNumber ?? null;
  useEffect(() => {
    const current = receiver.current;
    if (!current || sequence === null) return;
    current.armed = armed;
    const ack = current.acknowledge();
    if (ack) channel.current?.post(ack);
  }, [sequence, armed, state.generation]);

  const dispatch = useCallback((command: OperatorCommand) => {
    const message = receiver.current?.command(command, performance.now());
    if (message) channel.current?.post(message);
  }, []);

  const reportFont = useCallback((missing: boolean) => {
    const current = receiver.current;
    if (!current || current.fontMissing === missing) return;
    current.fontMissing = missing;
    const ack = current.acknowledge();
    if (ack) channel.current?.post(ack);
  }, []);

  const visual = state.visual;
  const live = state.status === 'live' && visual !== null;
  const interactive = armed && live && showControls && !controllerLost;

  // Atalhos permitidos são encaminhados ao controlador; nada é decidido aqui.
  const controlsRef = useRef(visual?.controls ?? null);
  useEffect(() => {
    controlsRef.current = visual?.controls ?? null;
  });
  useEffect(() => {
    if (!armed) return;
    function onKeyDown(event: KeyboardEvent) {
      const element = event.target as HTMLElement | null;
      if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)) return;
      if (event.key === ' ' && element?.closest('button')) return;
      // M reabre a preparação desta janela (tela cheia e controles).
      if ((event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setPreparing((open) => !open);
        return;
      }
      const controls = controlsRef.current;
      const command = controls && shortcutCommand(event, controls);
      if (!command) return;
      event.preventDefault();
      dispatch(command);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armed, dispatch]);

  function arm() {
    writeFlag('sessionStorage', ARMED_KEY, true);
    setArmed(true);
    setPreparing(false);
  }

  function chooseControls(value: boolean) {
    writeFlag('localStorage', CONTROLS_PREFERENCE, value);
    setShowControls(value);
  }

  function requestFullscreen() {
    setFullscreenError(false);
    document.documentElement.requestFullscreen().catch(() => setFullscreenError(true));
  }

  const attributes = {
    'data-testid': 'public-output',
    'data-status': state.status,
    'data-armed': armed,
    'data-controls': interactive,
    'data-controller-lost': controllerLost,
    'data-sequence': sequence ?? '',
    'data-generation': state.generation ?? '',
    'data-occurrence-id': visual?.frame.occurrenceId ?? '',
    'data-visual-mode': visual?.frame.visualMode ?? '',
  };

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-black" {...attributes}>
      {live && <FontReport slide={visual.frame.slide} onResult={reportFont} />}
      {/* Sem dados ou com a sessão encerrada, a saída fica preta. */}
      {armed && live && !interactive && (
        <div className="h-full w-full cursor-none">
          <SlideView fit="fill" text={visual.frame.slide.text} style={visual.frame.slide.style} fontId={visual.frame.slide.fontId} visualMode={visual.frame.visualMode} rotation={visual.rotation} />
        </div>
      )}
      {interactive && <InteractiveStage frame={visual.frame} rotation={visual.rotation} controls={visual.controls} dispatch={dispatch} onHideOutputControls={() => chooseControls(false)} />}

      {(!armed || preparing) && (
        <section aria-labelledby="preparo" data-testid="projection-setup" className="absolute inset-0 flex items-center justify-center bg-black/90 p-6">
          <div className="flex max-w-lg flex-col gap-4 rounded-xl border border-border-strong bg-surface-raised p-6">
            <h1 id="preparo" className="text-xl font-bold">
              Preparar esta janela de projeção
            </h1>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Arraste esta janela para o projetor ou segundo monitor (área estendida, não espelhada).</li>
              <li>Entre em tela cheia.</li>
              <li>Arme a saída: esta ajuda some e só o slide aparece.</li>
            </ol>
            <p role="status" className="text-sm text-muted" data-testid="setup-connection">
              {state.status === 'ended'
                ? 'A sessão foi encerrada pelo operador.'
                : live && !controllerLost
                  ? `Conectada ao painel do operador${state.info ? ` — ${state.info.title}` : ''}.`
                  : 'Aguardando o painel do operador…'}
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={showControls} onChange={(event) => chooseControls(event.target.checked)} />
              Mostrar controles nesta tela
            </label>
            <p className="text-xs text-muted">
              Desmarcado, o público vê só o slide. Marcado, os botões dos cantos aparecem aqui ao mover o ponteiro e são projetados enquanto
              estiverem visíveis. Depois de armar, a tecla M reabre esta preparação.
            </p>
            {fullscreenError && (
              <p role="alert" className="text-sm text-danger">
                O navegador recusou a tela cheia. Clique em &ldquo;Tela cheia&rdquo; de novo nesta janela.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass('secondary')} onClick={requestFullscreen}>
                Tela cheia
              </button>
              <button type="button" className={buttonClass('primary')} onClick={arm}>
                {armed ? 'Fechar preparação' : 'Armar saída'}
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
