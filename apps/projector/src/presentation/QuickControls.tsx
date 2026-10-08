'use client';

import type { ControlsState, OperatorCommand } from '@louvorvisual/presentation';
import { useEffect, useState, type ReactNode } from 'react';
import { useFocusLayer } from '@/input/focus';
import { LandscapeIcon, LargerIcon, MenuIcon, NextIcon, PauseIcon, PlayIcon, PortraitIcon, PreviousIcon, SmallerIcon, TimerIcon } from '@/ui/icons';
import { formatSeconds } from './labels';

type Props = {
  controls: ControlsState;
  /** Tempo restante lido do motor; `null` sem contagem. */
  remaining: () => number | null;
  dispatch: (command: OperatorCommand) => void;
  onMenu: () => void;
  onClose: () => void;
};

function Control({ label, testId, autoFocus, onSelect, children }: { label: string; testId: string; autoFocus?: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" tabIndex={-1} className="control" data-focusable="" data-autofocus={autoFocus ? '' : undefined} data-testid={testId} aria-label={label} onClick={onSelect}>
      {children}
      {/* Rótulo curto, só no botão em foco: de longe, o ícone sozinho não basta. */}
      <span className="control-label">{label}</span>
    </button>
  );
}

/** Contagem do slide atual; só existe com duração configurada (planejamento/20). */
function TimerIndicator({ controls, remaining }: Pick<Props, 'controls' | 'remaining'>) {
  const [left, setLeft] = useState<number | null>(null);
  const counting = controls.capabilities.countdown;
  useEffect(() => {
    if (!counting) return;
    const read = () => setLeft(remaining());
    const timer = window.setInterval(read, 200);
    return () => window.clearInterval(timer);
  }, [counting, remaining, controls.occurrenceId]);
  if (!controls.capabilities.timerIndicator || controls.durationMs === null) return null;
  const shown = counting && left !== null ? left : controls.durationMs;
  return (
    <span className="indicator" data-testid="timer-indicator" data-counting={counting}>
      <TimerIcon />
      {formatSeconds(shown)} s
    </span>
  );
}

/**
 * Controles rápidos nos quatro cantos, acompanhando a orientação da saída.
 * Abrem com cima/baixo e ficam até Voltar: com o
 * controle remoto sempre há um botão em foco, então nada some por inatividade.
 */
export function QuickControls({ controls, remaining, dispatch, onMenu, onClose }: Props) {
  const ref = useFocusLayer({
    name: 'controls',
    level: 1,
    repeat: 'directions',
    onBack: onClose,
    onKey: (key) => {
      if (key === 'menu') {
        onMenu();
        return true;
      }
      if (key === 'playPause') {
        if (controls.capabilities.transport) dispatch({ type: 'toggle' });
        return true;
      }
      return false;
    },
  });
  const { transport } = controls.capabilities;

  return (
    <div ref={ref} data-layer="controls" data-testid="quick-controls" data-rotation={controls.rotation}>
      <div className="corner corner-tl">
        <Control label="Ajustes" testId="control-menu" onSelect={onMenu}>
          <MenuIcon />
        </Control>
      </div>
      <div className="corner corner-tr">
        <span className="indicator" data-testid="slide-position">
          {controls.label} · {controls.index + 1} de {controls.total}
        </span>
        <Control label={controls.rotation === 0 ? 'Mudar para vertical (90°)' : 'Mudar para horizontal (0°)'} testId="control-rotate" onSelect={() => dispatch({ type: 'setRotation', rotation: controls.rotation === 0 ? 90 : 0 })}>
          {controls.rotation === 0 ? <PortraitIcon /> : <LandscapeIcon />}
        </Control>
      </div>
      <div className="corner corner-bl">
        <Control label="Slide anterior" testId="control-previous" onSelect={() => dispatch({ type: 'previous' })}>
          <PreviousIcon />
        </Control>
        <TimerIndicator controls={controls} remaining={remaining} />
      </div>
      <div className="corner corner-br">
        <Control label="Diminuir a letra" testId="control-smaller" onSelect={() => dispatch({ type: 'stepFontSize', direction: -1, scope: 'occurrence' })}>
          <SmallerIcon />
        </Control>
        {/* Sem play/pause, o foco inicial é o A+; com ele, o transporte. */}
        <Control label="Aumentar a letra" testId="control-larger" autoFocus={!transport} onSelect={() => dispatch({ type: 'stepFontSize', direction: 1, scope: 'occurrence' })}>
          <LargerIcon />
        </Control>
        {transport && (
          <Control label={controls.playing ? 'Pausar' : 'Tocar'} testId="control-transport" autoFocus onSelect={() => dispatch({ type: 'toggle' })}>
            {controls.playing ? <PauseIcon /> : <PlayIcon />}
          </Control>
        )}
        <Control label="Próximo slide" testId="control-next" onSelect={() => dispatch({ type: 'next' })}>
          <NextIcon />
        </Control>
      </div>
    </div>
  );
}
