'use client';

import { formatTimerSeconds, OCCURRENCE_DURATION_MS, parseTimerSeconds, type Uuid } from '@louvorvisual/domain';
import type { AudioControls, EngineNotice, EngineView, ResolvedSlide, SnapshotAudio } from '@louvorvisual/presentation';
import { useEffect, useReducer, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/lib/utils';
import { formatClock } from '../audio/htmlTransport';
import type { SessionController } from './controller';
import { AUDIO_KIND_TEXT, AUDIO_POLICY_TEXT, formatSeconds } from './labels';
import type { Dispatch } from './LiveMenu';
import type { AudioChoice } from './useOperatorSession';

/** Posição da faixa lida do player a cada desenho; não é outro relógio. */
function usePosition(controller: SessionController): number {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(redraw, 200);
    return () => window.clearInterval(timer);
  }, []);
  return controller.engine.audioPositionMs() ?? 0;
}

function Position({ controller, audio, dispatch }: { controller: SessionController; audio: AudioControls; dispatch: Dispatch }) {
  const position = usePosition(controller);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? position;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm tabular-nums" data-testid="audio-position" data-position-ms={Math.round(position)}>
        {formatClock(shown)} / {formatClock(audio.durationMs)}
      </p>
      {audio.policy === 'independent' && (
        <input
          type="range"
          aria-label="Posição da faixa"
          data-testid="audio-seek"
          className="w-full accent-accent"
          min={0}
          max={Math.floor(audio.durationMs)}
          step={100}
          value={Math.min(Math.floor(audio.durationMs), Math.round(shown))}
          // Arrastar só move o indicador; o pedido ao player sai ao soltar.
          onChange={(event) => setDragging(Number(event.target.value))}
          onPointerUp={() => commit()}
          onKeyUp={() => commit()}
          onBlur={() => commit()}
        />
      )}
    </div>
  );

  function commit() {
    if (dragging === null) return;
    dispatch({ type: 'audioSeek', positionMs: dragging });
    setDragging(null);
  }
}

const NOTICE_TEXT: Partial<Record<NonNullable<EngineNotice>, string>> = {
  'autoplay-blocked': 'O navegador bloqueou o som até um clique seu nesta janela. A faixa não está tocando.',
  'seek-failed': 'Não foi possível reposicionar a faixa. A apresentação ficou em pausa no último ponto confirmado; escolha o slide de novo.',
  'audio-stalled': 'A faixa parou de avançar sem pausa pedida. O slide e o contador seguem a posição real dela.',
  'audio-ended-early': 'A gravação terminou antes do fim previsto dos slides. A apresentação ficou em pausa.',
  'audio-failed': 'A faixa falhou durante a reprodução.',
};

type AudioPanelProps = {
  controller: SessionController;
  view: EngineView;
  dispatch: Dispatch;
  choices: AudioChoice[];
  selectedBindingId: Uuid | null;
  onChoose: (bindingId: Uuid | null) => void;
};

/**
 * Faixa da sessão no painel do operador: o que está tocando, de onde, com que
 * política, e as falhas com a ação que resolve. O único player é o desta janela.
 */
export function AudioPanel({ controller, view, dispatch, choices, selectedBindingId, onChoose }: AudioPanelProps) {
  const { state, notice } = view;
  const audio = view.controls.audio;
  const ready = state.status === 'ready';
  const noticeText = notice ? NOTICE_TEXT[notice] : undefined;

  return (
    <section aria-labelledby="faixa" className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="audio-panel" data-policy={state.audioPolicy} data-playing={audio?.playing ?? false} data-seeking={audio?.seeking ?? false} data-notice={notice ?? ''}>
      <h2 id="faixa" className="text-sm font-semibold text-muted">
        Faixa de áudio
      </h2>

      {ready && choices.length > 0 && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">Faixa desta sessão</legend>
          <label className="flex cursor-pointer items-center gap-1">
            <input type="radio" name="faixa-sessao" className="accent-accent" checked={selectedBindingId === null} onChange={() => onChoose(null)} />
            Sem áudio
          </label>
          {choices.map((choice) => (
            <label key={choice.bindingId} className="flex cursor-pointer items-center gap-1">
              <input type="radio" name="faixa-sessao" className="accent-accent" checked={selectedBindingId === choice.bindingId} onChange={() => onChoose(choice.bindingId)} />
              {AUDIO_KIND_TEXT[choice.kind]}
            </label>
          ))}
        </fieldset>
      )}

      {!audio ? (
        <p className="text-sm text-muted" data-testid="audio-none">
          Sem faixa nesta sessão.
        </p>
      ) : (
        <>
          <p className="text-sm">
            <span className="font-semibold">{AUDIO_KIND_TEXT[audio.kind]}</span> · {audio.filename} · {AUDIO_POLICY_TEXT[audio.policy]}
          </p>
          <Position controller={controller} audio={audio} dispatch={dispatch} />
          <div className="flex flex-wrap items-center gap-2">
            {(ready || audio.policy === 'independent') && (
              <button type="button" className={buttonClass('secondary', 'sm')} data-testid="audio-toggle" onClick={() => dispatch({ type: 'audioToggle' })}>
                {audio.playing ? '❚❚ Pausar faixa' : ready ? '▶ Testar som' : '▶ Tocar faixa'}
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-muted">
              Volume
              <input type="range" aria-label="Volume da faixa" data-testid="audio-volume" className="w-28 accent-accent" min={0} max={1} step={0.05} value={audio.volume} onChange={(event) => dispatch({ type: 'setVolume', volume: Number(event.target.value) })} />
              <span className="tabular-nums">{Math.round(audio.volume * 100)}%</span>
            </label>
          </div>

          {audio.policy === 'independent' ? (
            <>
              <Checkbox label="Pausar a faixa junto com a apresentação" checked={audio.followsPause} onChange={(event) => dispatch({ type: 'setAudioFollowsPause', value: event.target.checked })} />
              <p className="text-xs text-muted">
                Trocar de slide não mexe na faixa. Em slide com tempo no automático, pausar a apresentação pausa a faixa junto; desmarque para um transporte separado. Sem
                tempo no slide, o play/pause controla só a faixa.
              </p>
            </>
          ) : state.mode === 'manual' ? (
            <p className="text-xs text-muted" data-testid="linked-manual-hint">
              Avanço manual: a faixa não passa os slides sozinha e continua tocando se você não avançar. Saltar reposiciona a faixa no início do slide. Para os slides
              acompanharem a faixa, use o automático.
            </p>
          ) : (
            <p className="text-xs text-muted">Os slides acompanham a posição da faixa. Saltar reposiciona a faixa e continua.</p>
          )}

          {ready && <p className="text-xs text-muted">Confira o volume e teste o som. Iniciar volta a faixa ao ponto de partida.</p>}
          {audio.seeking && (
            <p role="status" className="text-xs text-muted" data-testid="audio-seeking">
              Reposicionando a faixa…
            </p>
          )}
          {state.status === 'finished' && audio.playing && (
            <p role="status" className="text-sm" data-testid="audio-still-playing">
              Os slides terminaram; a faixa continua tocando. Use &ldquo;Pausar faixa&rdquo; ou &ldquo;Parar&rdquo;.
            </p>
          )}
        </>
      )}

      {noticeText && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger p-2 text-sm" data-testid="audio-notice">
          <p>⚠ {noticeText}</p>
          <div className="flex flex-wrap gap-2">
            {notice === 'autoplay-blocked' && (
              <button type="button" className={buttonClass('primary', 'sm')} onClick={() => dispatch(audio?.policy === 'linked' ? { type: 'resume' } : { type: 'audioPlay' })}>
                ▶ Tocar agora
              </button>
            )}
            {(notice === 'audio-ended-early' || notice === 'audio-failed') && audio && (
              <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => dispatch({ type: 'dropAudio' })}>
                Seguir sem a faixa, com avanço manual
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type LinkedTimingProps = {
  slides: ResolvedSlide[];
  currentId: Uuid;
  audio: SnapshotAudio;
  status: EngineView['state']['status'];
  dispatch: Dispatch;
};

/**
 * Tempo com faixa vinculada (planejamento/20): duração e intervalos mudam
 * juntos. O rascunho é privado e não toca na música; aplicar pede pausa e
 * revalida os intervalos contra a gravação. Remover tempo oferece desvincular.
 */
export function LinkedTiming({ slides, currentId, audio, status, dispatch }: LinkedTimingProps) {
  const [draft, setDraft] = useState<Record<Uuid, string> | null>(null);
  const [removing, setRemoving] = useState(false);
  const current = slides.find((slide) => slide.occurrenceId === currentId);

  if (draft === null) {
    return (
      <div className="flex flex-col gap-2 text-xs" data-testid="linked-timing">
        <p>
          ⏱ {current?.durationMs != null ? `${formatSeconds(current.durationMs)} s neste slide` : 'sem tempo'} · faixa vinculada
        </p>
        <p className="text-muted">Com a faixa vinculada, os tempos e os intervalos da gravação mudam juntos, em uma revisão feita em pausa.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(Object.fromEntries(slides.map((slide) => [slide.occurrenceId, formatTimerSeconds(slide.durationMs ?? OCCURRENCE_DURATION_MS.min)])))}>
            Revisar tempos…
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setRemoving(true)}>
            Remover tempo deste slide…
          </button>
        </div>
        {removing && (
          <div role="alertdialog" aria-label="Remover tempo com faixa vinculada" className="flex flex-col gap-2 rounded-lg border border-border-strong p-2" data-testid="unlink-offer">
            <p>
              Um slide sem tempo não pode ficar vinculado à faixa. Você pode desvincular: a faixa continua exatamente de onde está, como independente, e os slides passam a
              avançar só por você.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass('primary', 'sm')}
                onClick={() => {
                  dispatch({ type: 'unlinkAudio' });
                  dispatch({ type: 'setDuration', occurrenceId: currentId, durationMs: null });
                  setRemoving(false);
                }}
              >
                Desvincular a faixa e usar avanço manual
              </button>
              <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setRemoving(false)}>
                Manter vinculada
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const parsed = slides.map((slide) => parseTimerSeconds(draft[slide.occurrenceId] ?? ''));
  const invalid = parsed.some((value) => value === null);
  const intervals = parsed.reduce<{ start: number; end: number }[]>((list, value) => {
    const start = list.at(-1)?.end ?? audio.offsetMs;
    return [...list, { start, end: start + (value ?? 0) }];
  }, []);
  const cursor = intervals.at(-1)?.end ?? audio.offsetMs;
  const beyond = !invalid && cursor > audio.durationMs;
  const changed = Object.fromEntries(slides.flatMap((slide, index) => (parsed[index] !== null && parsed[index] !== slide.durationMs ? [[slide.occurrenceId, parsed[index] as number]] : [])));
  const running = status === 'running';
  const canApply = !invalid && !beyond && !running && Object.keys(changed).length > 0;

  return (
    <form
      className="flex flex-col gap-2 text-xs"
      data-testid="linked-timing-draft"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canApply) return;
        dispatch({ type: 'applyLinkedTiming', durations: changed });
        setDraft(null);
      }}
    >
      <p className="font-semibold">Rascunho dos tempos (só você vê)</p>
      <p className="text-muted">Digitar aqui não muda a apresentação nem reposiciona a música. Os intervalos são calculados a partir de {formatClock(audio.offsetMs)} da gravação.</p>
      <ol className="flex flex-col gap-1">
        {slides.map((slide, index) => (
          <li key={slide.occurrenceId} className={cn('grid grid-cols-[1fr_4.5rem_5.5rem] items-center gap-2', slide.occurrenceId === currentId && 'font-semibold')}>
            <label htmlFor={`tempo-vinculado-${slide.occurrenceId}`} className="truncate">
              {index + 1} · {slide.label || 'Sem rótulo'}
            </label>
            <input
              id={`tempo-vinculado-${slide.occurrenceId}`}
              inputMode="decimal"
              aria-label={`Tempo do slide ${index + 1}, em segundos`}
              aria-invalid={parsed[index] === null || undefined}
              className={cn('rounded border bg-surface-raised px-1 py-1 text-center', parsed[index] === null ? 'border-danger' : 'border-border-strong')}
              value={draft[slide.occurrenceId] ?? ''}
              onChange={(event) => setDraft({ ...draft, [slide.occurrenceId]: event.target.value })}
            />
            <span className="tabular-nums text-muted" data-testid="linked-interval">
              {parsed[index] === null ? '—' : `${formatClock((intervals[index] as { start: number }).start)}–${formatClock((intervals[index] as { end: number }).end)}`}
            </span>
          </li>
        ))}
      </ol>
      {invalid && (
        <p role="alert" className="text-danger">
          Cada slide precisa de 0,5 a 600 segundos. Para deixar um slide sem tempo, desvincule a faixa.
        </p>
      )}
      {beyond && (
        <p role="alert" className="text-danger" data-testid="linked-beyond">
          Os intervalos terminam em {formatClock(cursor)} e a gravação tem {formatClock(audio.durationMs)}. Reduza os tempos.
        </p>
      )}
      {running && !invalid && !beyond && (
        <p role="status" data-testid="linked-needs-pause">
          Aplicar reposiciona a faixa no início do slide atual. Pause a apresentação para aplicar.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {running && (
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => dispatch({ type: 'pause' })}>
            ❚❚ Pausar para aplicar
          </button>
        )}
        <button type="submit" className={buttonClass('primary', 'sm')} disabled={!canApply}>
          Aplicar tempos revisados
        </button>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(null)}>
          Descartar
        </button>
      </div>
    </form>
  );
}
