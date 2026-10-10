'use client';

import type { ControlsState, OutputFrame, Rotation } from '@louvorvisual/presentation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { SlideView } from '@/components/SlideView';
import { cn } from '@/lib/utils';
import { buttonClass } from '@/components/ui/buttonStyles';
import { deviceOrientation, enterPresentationFullscreen, exitPresentationFullscreen, subscribeDeviceOrientation } from '@/presentation/fullscreen';
import { CloseIcon, LandscapeIcon, PortraitIcon, FullscreenIcon, LargerIcon, MenuIcon, NextIcon, PauseIcon, PlayIcon, PreviousIcon, SmallerIcon, TimerIcon } from './icons';
import { formatSeconds } from './labels';
import { LiveMenu, type Dispatch } from './LiveMenu';

/** Controles somem depois deste tempo sem interação (planejamento/20). */
export const CONTROLS_HIDE_AFTER_MS = 3000;

// Repouso: fundo transparente, borda de 1 px e ícone em cinza claro com alfa
// na cor — nunca opacidade no botão inteiro, para o foco continuar legível.
const cornerButton =
  'inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-[rgba(209,213,219,0.35)] bg-transparent px-2 ' +
  'text-sm font-semibold tabular-nums text-[rgba(209,213,219,0.75)] transition-colors duration-150 ' +
  'hover:border-[rgba(209,213,219,0.9)] hover:text-[#D1D5DB] focus-visible:border-[#D1D5DB] focus-visible:text-[#D1D5DB] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D1D5DB]';

const closeButton = 'border-danger text-danger hover:border-danger hover:text-danger focus-visible:border-danger focus-visible:text-danger';

function CornerButton({ label, onClick, children, testId, pressed, className }: { label: string; onClick: () => void; children: ReactNode; testId: string; pressed?: boolean; className?: string }) {
  return (
    <button type="button" className={cn(cornerButton, className)} aria-label={label} title={label} aria-pressed={pressed} data-testid={testId} data-corner-button onClick={onClick}>
      {children}
    </button>
  );
}

type InteractiveStageProps = {
  frame: OutputFrame;
  rotation: Rotation;
  controls: ControlsState;
  dispatch: Dispatch;
  /** Só o operador tem relógio: recebe o tempo restante para a contagem. A saída pública mostra a duração fixa. */
  countdown?: ReactNode;
  operatorItems?: ReactNode;
  linkedTiming?: ReactNode;
  onHideOutputControls?: () => void;
  /** Voltar ao painel do operador após sair da tela cheia. */
  onExit?: () => void;
  /** Aviso discreto sobre o que o público vê (congelada, preta…). */
  badge?: ReactNode;
  /** Mantém os controles à vista por outro motivo (ex.: rascunho de texto aberto). */
  pinned?: boolean;
};

/**
 * Apresentação interativa: o slide ocupa a área e os controles ficam nos quatro
 * cantos, na orientação normal mesmo com a composição girada. Usada no monitor
 * do operador e, quando habilitada, na própria janela pública.
 */
export function InteractiveStage({ frame, rotation, controls, dispatch, countdown, operatorItems, linkedTiming, onHideOutputControls, onExit, badge, pinned = false }: InteractiveStageProps) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const timer = useRef<number | null>(null);
  const [needsRotation, setNeedsRotation] = useState(false);
  const physicalOrientation = useSyncExternalStore(subscribeDeviceOrientation, deviceOrientation, () => 'desktop' as const);
  const displayRequested = useRef(false);
  const fullscreenBusy = useRef(false);
  const rotationDialog = useRef<HTMLDivElement>(null);

  const hasFocusedControl = useCallback(() => {
    const focused = document.activeElement;
    // Foco de teclado em um controle: não esconder embaixo de quem está navegando.
    return focused instanceof HTMLElement && root.current?.contains(focused) === true && focused.matches('[data-stage-ui] :focus-visible');
  }, []);

  const wake = useCallback(() => {
    setActive(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(function hide() {
      if (hasFocusedControl()) {
        timer.current = window.setTimeout(hide, CONTROLS_HIDE_AFTER_MS);
        return;
      }
      setActive(false);
    }, CONTROLS_HIDE_AFTER_MS);
  }, [hasFocusedControl]);

  useEffect(() => {
    wake();
    const events = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, wake);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [wake]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) displayRequested.current = false;
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!needsRotation) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = rotationDialog.current;
    dialog?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNeedsRotation(false);
      if (event.key !== 'Tab' || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [needsRotation]);

  const visible = active || menuOpen || pinned || needsRotation;

  async function exitPresentation() {
    if (fullscreenBusy.current) return;
    fullscreenBusy.current = true;
    setFullscreenError(false);
    try {
      await exitPresentationFullscreen();
      displayRequested.current = false;
      setNeedsRotation(false);
      onExit?.();
    } catch {
      setFullscreenError(true);
    } finally {
      fullscreenBusy.current = false;
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement || displayRequested.current) {
      await exitPresentation();
      return;
    }
    if (fullscreenBusy.current) return;
    fullscreenBusy.current = true;
    setFullscreenError(false);
    try {
      const result = await enterPresentationFullscreen();
      if (!root.current) return;
      if (result === 'rotate-device') {
        setNeedsRotation(true);
        return;
      }
      displayRequested.current = true;
      setNeedsRotation(false);
    } catch {
      setFullscreenError(true);
    } finally {
      fullscreenBusy.current = false;
    }
  }

  const { capabilities } = controls;
  // Com transporte separado e slide sem tempo, o botão mostra a faixa, não a sessão.
  const playing = controls.playing;
  const autoAdvancing = capabilities.countdown;
  const effectiveRotation = physicalOrientation === 'desktop' ? rotation : 0;
  const uiFrame: CSSProperties = effectiveRotation === 90 ? { top: '50%', left: '50%', width: '100cqh', height: '100cqw', transform: 'translate(-50%, -50%) rotate(90deg)' } : { inset: 0 };
  const corner = cn('absolute flex items-center gap-2 transition-opacity duration-150', visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none invisible opacity-0');

  return (
    <div ref={root} className={cn('relative h-full w-full overflow-hidden', !visible && 'cursor-none')} style={{ containerType: 'size' }} data-testid="interactive-stage" data-controls-visible={visible} data-ui-rotation={effectiveRotation}>
      <SlideView fit="fill" text={frame.slide.text} style={frame.slide.style} fontId={frame.slide.fontId} visualMode={frame.visualMode} rotation={effectiveRotation} cover={frame.cover} transitionKey={`${frame.occurrenceId}:${frame.cover ? 'abertura' : 'letra'}`} />

      <div className="pointer-events-none absolute" style={uiFrame} data-testid="stage-ui-frame">
        {menuOpen && <div data-stage-ui className="pointer-events-auto absolute inset-0" data-testid="stage-menu-backdrop" onClick={() => setMenuOpen(false)} />}
      <div data-stage-ui className={cn(corner, 'left-4 top-4')} data-corner="top-left">
        <CornerButton label={menuOpen ? 'Fechar ajustes' : 'Abrir ajustes'} testId="corner-menu" pressed={menuOpen} className={menuOpen ? closeButton : undefined} onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen ? <CloseIcon /> : <MenuIcon />}
        </CornerButton>
      </div>

      <div data-stage-ui className={cn(corner, 'right-4 top-4')} data-corner="top-right">
        {badge}
        {onExit && (
          <button type="button" className="rounded-lg border border-[rgba(209,213,219,0.35)] px-2 py-2 text-xs hover:border-[rgba(209,213,219,0.9)] focus-visible:outline-2 focus-visible:outline-[#D1D5DB]" onClick={() => void exitPresentation()}>
            Painel completo
          </button>
        )}
        <CornerButton label={physicalOrientation === 'desktop' ? `Girar a saída 90° (agora ${rotation}°)` : 'Girar o celular para a horizontal'} testId="corner-rotate" onClick={() => {
          if (physicalOrientation === 'desktop') dispatch({ type: 'setRotation', rotation: rotation === 0 ? 90 : 0 });
          else setNeedsRotation(true);
        }}>
          {physicalOrientation === 'desktop' && rotation === 0 ? <PortraitIcon /> : <LandscapeIcon />}
        </CornerButton>
        <CornerButton label="Entrar ou sair da tela cheia" testId="corner-fullscreen" onClick={toggleFullscreen}>
          <FullscreenIcon />
        </CornerButton>
      </div>

      <div data-stage-ui className={cn(corner, 'bottom-4 left-4')} data-corner="bottom-left">
        <CornerButton label="Slide anterior" testId="corner-previous" onClick={() => dispatch({ type: 'previous' })}>
          <PreviousIcon />
        </CornerButton>
        {/* Sem duração no slide atual não existe indicador de tempo, nem um contador vazio. */}
        {capabilities.timerIndicator && controls.durationMs !== null && (
          <CornerButton label="Temporizador deste slide" testId="corner-timer" onClick={() => setMenuOpen(true)}>
            <TimerIcon />
            {countdown ?? <span data-testid="timer-static">{formatSeconds(controls.durationMs)} s</span>}
          </CornerButton>
        )}
      </div>

      <div data-stage-ui className={cn(corner, 'bottom-4 right-4')} data-corner="bottom-right">
        <CornerButton label="Diminuir a letra" testId="corner-smaller" onClick={() => dispatch({ type: 'stepFontSize', direction: -1, scope: 'occurrence' })}>
          <SmallerIcon />
        </CornerButton>
        <CornerButton label="Aumentar a letra" testId="corner-larger" onClick={() => dispatch({ type: 'stepFontSize', direction: 1, scope: 'occurrence' })}>
          <LargerIcon />
        </CornerButton>
        {capabilities.transport && (
          <CornerButton label={playing ? 'Pausar' : 'Retomar'} testId="corner-transport" onClick={() => dispatch({ type: 'toggle' })}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </CornerButton>
        )}
        <CornerButton label={autoAdvancing ? 'Próximo slide (avanço automático em andamento)' : controls.cover ? 'Mostrar a letra' : 'Próximo slide'} testId="corner-next" onClick={() => dispatch({ type: 'next' })}>
          {autoAdvancing ? <span className="lv-auto-spinner" data-testid="auto-spinner" aria-hidden="true" /> : <NextIcon />}
        </CornerButton>
      </div>

      {needsRotation && (
        <div ref={rotationDialog} data-stage-ui role="dialog" aria-modal="true" aria-labelledby="rotate-device-title" data-testid="rotation-help" className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-black/90 p-4">
          <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-strong bg-surface-raised p-6 text-center">
            <h2 id="rotate-device-title" className="text-xl font-bold">Gire o celular para a horizontal</h2>
            <p>Ative a rotação automática do celular e deite o aparelho. Espere a tela do sistema girar para o projetor acompanhar.</p>
            <p role="status" data-testid="device-orientation-status" className="text-sm text-muted">
              {physicalOrientation === 'landscape' ? 'Celular na horizontal. Agora você pode entrar em tela cheia.' : physicalOrientation === 'unknown' ? 'Não foi possível detectar a orientação. Confirme que a tela do celular já está na horizontal.' : 'Aguardando a rotação real do celular…'}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className={buttonClass('primary')} disabled={physicalOrientation === 'portrait'} onClick={() => {
                if (displayRequested.current || document.fullscreenElement) setNeedsRotation(false);
                else void toggleFullscreen();
              }}>
                {physicalOrientation === 'unknown' ? 'Já girei o celular — entrar' : 'Entrar em tela cheia'}
              </button>
              <button type="button" className={buttonClass('secondary')} onClick={() => setNeedsRotation(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {fullscreenError && (
        <p role="alert" data-stage-ui className="pointer-events-auto absolute left-1/2 top-4 -translate-x-1/2 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm">
          Não foi possível entrar ou sair da tela cheia. Tente novamente.
        </p>
      )}

      {menuOpen && (
        <div data-stage-ui role="dialog" aria-label="Ajustes da apresentação" className="pointer-events-auto absolute bottom-20 left-4 top-20 w-[min(24rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-border-strong bg-surface-raised p-4 shadow-xl">
          <LiveMenu allowOutputRotation={physicalOrientation === 'desktop'} controls={controls} dispatch={dispatch} operatorItems={operatorItems} linkedTiming={linkedTiming} onHideOutputControls={onHideOutputControls} />
        </div>
      )}
      </div>
    </div>
  );
}
