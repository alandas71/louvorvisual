'use client';

import { BUNDLED_FONTS, FONT_SIZE_PX, FONT_WEIGHTS, TEXT_ALIGNS, THEME_PRESETS, type TextAlign } from '@louvorvisual/domain';
import { fontStack, ROTATIONS, type AdjustScope, type ControlsState, type OperatorCommand } from '@louvorvisual/presentation';
import { useState, type ReactNode } from 'react';
import { buttonClass, pressedClass } from '@/components/ui/buttonStyles';
import { cn } from '@/lib/utils';
import { TimerField } from '../editor/TimerField';
import { LandscapeIcon, PortraitIcon } from './icons';

export type Dispatch = (command: OperatorCommand) => void;

type LiveMenuProps = {
  controls: ControlsState;
  dispatch: Dispatch;
  /** Itens que só existem na área do operador (texto, salvar no arranjo). */
  operatorItems?: ReactNode;
  /** Revisão de tempos com faixa vinculada; só a área do operador a oferece. */
  linkedTiming?: ReactNode;
  /** Só na janela pública: voltar à saída limpa. */
  onHideOutputControls?: () => void;
  className?: string;
  /** Espelhamento móvel usa a orientação do sistema, sem girar o slide. */
  allowOutputRotation?: boolean;
};

const ALIGN_LABEL: Record<TextAlign, string> = { left: 'Esquerda', center: 'Centro', right: 'Direita' };
const SCOPE_LABEL: Record<AdjustScope, string> = { occurrence: 'Este slide', song: 'Todos os slides deste louvor' };
const LINE_HEIGHTS = [1, 1.2, 1.4, 1.6];

function Section({ title, scope, children }: { title: string; scope?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        {scope}
      </div>
      {children}
    </section>
  );
}

function ScopePicker({ name, value, onChange }: { name: string; value: AdjustScope; onChange: (scope: AdjustScope) => void }) {
  return (
    <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      <legend className="sr-only">Onde aplicar: {name}</legend>
      {(['occurrence', 'song'] as const).map((scope) => (
        <label key={scope} className="flex cursor-pointer items-center gap-1">
          <input type="radio" name={`escopo-${name}`} className="accent-accent" checked={value === scope} onChange={() => onChange(scope)} />
          {SCOPE_LABEL[scope]}
        </label>
      ))}
    </fieldset>
  );
}

const pill = (active: boolean) => cn(buttonClass('secondary', 'sm'), active && pressedClass);

/**
 * Modo de avanço. Semi-automático: a abertura espera o operador e depois os
 * tempos dos slides correm. Automático: a abertura também tem tempo, o
 * temporizador da introdução, que só se define no editor; sem ele, o botão
 * fica desligado.
 */
export function ModeButtons({ controls, dispatch, variant = 'pill' }: { controls: ControlsState; dispatch: Dispatch; variant?: 'pill' | 'ghost' }) {
  const style = (active: boolean) => (variant === 'pill' ? pill(active) : cn(buttonClass('ghost', 'sm'), active && pressedClass));
  const timed = controls.mode === 'automatic';
  const full = timed && controls.intro?.auto === true;
  function choose(mode: 'manual' | 'automatic', autoIntro?: boolean) {
    if (autoIntro !== undefined && controls.intro && controls.intro.auto !== autoIntro) dispatch({ type: 'setAutoIntro', enabled: autoIntro });
    if (controls.mode !== mode) dispatch({ type: 'setMode', mode });
  }
  return (
    <>
      <button type="button" className={style(controls.mode === 'manual')} aria-pressed={controls.mode === 'manual'} onClick={() => choose('manual')}>
        Manual
      </button>
      <button type="button" className={style(timed && !full)} aria-pressed={timed && !full} data-testid="mode-semi" onClick={() => choose('automatic', false)}>
        Semi-automático
      </button>
      <button
        type="button"
        className={style(full)}
        aria-pressed={full}
        data-testid="mode-automatic"
        disabled={!controls.intro}
        title={controls.intro ? undefined : 'Defina o temporizador da introdução no editor do louvor para usar o automático.'}
        onClick={() => choose('automatic', true)}
      >
        Automático
      </button>
    </>
  );
}

/**
 * Ajustes ao vivo (planejamento/20). Só envia comandos: quem executa é o motor
 * único, esteja este menu no painel do operador ou numa saída com controles.
 */
export function LiveMenu({ controls, dispatch, operatorItems, linkedTiming, onHideOutputControls, className, allowOutputRotation = true }: LiveMenuProps) {
  // Por padrão os ajustes valem para o louvor inteiro: é esse escopo que fica guardado como preferência do operador.
  const [styleScope, setStyleScope] = useState<AdjustScope>('song');
  const [themeScope, setThemeScope] = useState<AdjustScope>('song');
  const { appearance } = controls;

  return (
    <div className={cn('flex flex-col gap-3 text-sm', className)} data-testid="live-menu">
      <Section title="Temas" scope={<ScopePicker name="tema" value={themeScope} onChange={setThemeScope} />}>
        <ul className="grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((preset) => (
            <li key={preset.presetId}>
              <button
                type="button"
                aria-pressed={appearance.themePresetId === preset.presetId}
                data-theme={preset.presetId}
                onClick={() => dispatch({ type: 'adjust', scope: themeScope, patch: { themePresetId: preset.presetId } })}
                className={cn(
                  'w-full cursor-pointer rounded-lg border-2 px-2.5 py-2 text-left text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  appearance.themePresetId === preset.presetId ? 'border-accent' : 'border-transparent hover:border-border-strong',
                )}
                style={{ backgroundColor: preset.style.palette.backgroundColor, color: preset.style.palette.textColor }}
              >
                {preset.name}
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Fonte" scope={<ScopePicker name="fonte" value={styleScope} onChange={setStyleScope} />}>
        <ul className="grid grid-cols-2 gap-2">
          {BUNDLED_FONTS.map((font) => {
            const active = appearance.fontId === font.fontId;
            return (
              <li key={font.fontId}>
                <button
                  type="button"
                  aria-pressed={active}
                  data-font={font.fontId}
                  onClick={() => dispatch({ type: 'adjust', scope: styleScope, patch: { fontId: font.fontId } })}
                  className={cn(pill(active), 'w-full justify-start')}
                  style={{ fontFamily: fontStack(font.fontId) }}
                >
                  {font.family}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Peso da letra">
          {FONT_WEIGHTS.map((weight) => (
            <button key={weight} type="button" className={pill(appearance.fontWeight === weight)} aria-pressed={appearance.fontWeight === weight} onClick={() => dispatch({ type: 'adjust', scope: styleScope, patch: { fontWeight: weight } })}>
              {weight === 400 ? 'Regular' : 'Negrito'}
            </button>
          ))}
        </div>
        {appearance.fontChosen && (
          <button type="button" className={cn(buttonClass('secondary', 'sm'), 'self-start')} onClick={() => dispatch({ type: 'resetAdjustment', scope: styleScope, keys: ['fontId'] })}>
            Usar a fonte inicial do tema
          </button>
        )}
      </Section>

      <Section title="Tamanho da letra">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={appearance.fontSizePx <= FONT_SIZE_PX.min} onClick={() => dispatch({ type: 'stepFontSize', direction: -1, scope: styleScope })} aria-label="Diminuir a letra">
            A−
          </button>
          <span data-testid="menu-font-size" data-font-size={appearance.fontSizePx} className="min-w-16 text-center tabular-nums">
            {appearance.fontSizePx} px
          </span>
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={appearance.fontSizePx >= FONT_SIZE_PX.max} onClick={() => dispatch({ type: 'stepFontSize', direction: 1, scope: styleScope })} aria-label="Aumentar a letra">
            A+
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => dispatch({ type: 'resetAdjustment', scope: styleScope, keys: ['fontSizePx'] })}>
            Tamanho inicial
          </button>
        </div>
        <p className="text-xs text-muted">Vale para: {SCOPE_LABEL[styleScope].toLowerCase()} (o mesmo escopo da fonte).</p>
      </Section>

      <Section title="Temporizador deste slide">
        {controls.audio?.policy === 'linked' ? (
          // Faixa vinculada: nada de aplicar tempo direto; a revisão acontece em pausa, na área do operador.
          (linkedTiming ?? (
            <p className="text-xs text-muted" data-testid="linked-timing-readonly">
              ⏱ {controls.durationMs === null ? 'sem tempo' : `${(controls.durationMs / 1000).toLocaleString('pt-BR')} s`} · com a faixa vinculada, o tempo é revisado no painel do operador.
            </p>
          ))
        ) : (
          <>
            <TimerField target="slide atual" durationMs={controls.durationMs} onChange={(durationMs) => dispatch({ type: 'setDuration', occurrenceId: controls.occurrenceId, durationMs })} />
            <p className="text-xs text-muted">Aplicar reinicia a contagem deste slide. Em pausa, continua em pausa.</p>
          </>
        )}
      </Section>

      <Section title="Avanço">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Modo de avanço">
          <ModeButtons controls={controls} dispatch={dispatch} />
        </div>
        <p className="text-xs text-muted" data-testid="intro-timer-info">
          {controls.intro
            ? `Automático: a letra entra sozinha quando a ${controls.audio ? 'música' : 'apresentação'} chega a ${(controls.intro.durationMs / 1000).toLocaleString('pt-BR')} s. O tempo da introdução é definido no editor.`
            : 'O automático precisa do temporizador da introdução, definido no editor do louvor.'}
        </p>
        {controls.awaitingManualAdvance && (
          <p className="text-xs text-muted" data-testid="awaiting-advance">
            {controls.cover ? 'Abertura na tela: avance para mostrar a letra.' : 'Este slide não tem tempo: o avanço espera você.'}
          </p>
        )}
      </Section>

      {allowOutputRotation && <Section title="Rotação desta saída">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Rotação da saída pública">
          {ROTATIONS.map((rotation) => (
            <button key={rotation} type="button" className={pill(controls.rotation === rotation)} aria-label={rotation === 0 ? 'Horizontal (0°)' : 'Vertical (90°)'} aria-pressed={controls.rotation === rotation} onClick={() => dispatch({ type: 'setRotation', rotation })}>
              {rotation === 0 ? <LandscapeIcon /> : <PortraitIcon />}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">Gira só a composição do slide; fica guardada neste dispositivo, não no arranjo.</p>
      </Section>}

      <Section title="Alinhamento e entrelinha" scope={<span className="text-xs text-muted">{SCOPE_LABEL[styleScope]}</span>}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Alinhamento">
          {TEXT_ALIGNS.map((align) => (
            <button key={align} type="button" className={pill(appearance.textAlign === align)} aria-pressed={appearance.textAlign === align} onClick={() => dispatch({ type: 'adjust', scope: styleScope, patch: { textAlign: align } })}>
              {ALIGN_LABEL[align]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Entrelinha">
          {LINE_HEIGHTS.map((lineHeight) => (
            <button key={lineHeight} type="button" className={pill(appearance.lineHeight === lineHeight)} aria-pressed={appearance.lineHeight === lineHeight} onClick={() => dispatch({ type: 'adjust', scope: styleScope, patch: { lineHeight } })}>
              {lineHeight.toLocaleString('pt-BR')}
            </button>
          ))}
        </div>
      </Section>

      {controls.audio && (
        <Section title="Áudio">
          <p className="text-xs" data-testid="menu-audio-track">
            {controls.audio.kind === 'playback' ? 'Playback' : 'Áudio original'} · {controls.audio.filename}
            {controls.audio.policy === 'linked' ? ' · vinculada aos slides' : ' · independente'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Vinculada: o play/pause é o da apresentação. O som sai sempre do player único do operador. */}
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              data-testid="menu-audio-toggle"
              disabled={controls.audio.policy === 'linked' && controls.status === 'ready'}
              onClick={() => dispatch(controls.audio?.policy === 'linked' ? { type: 'toggle' } : { type: 'audioToggle' })}
            >
              {(controls.audio.policy === 'linked' ? controls.status === 'running' : controls.audio.playing) ? '❚❚ Pausar' : '▶ Tocar'}
            </button>
            <label className="flex items-center gap-2 text-xs text-muted">
              Volume
              <input type="range" aria-label="Volume da faixa" className="w-24 accent-accent" min={0} max={1} step={0.05} value={controls.audio.volume} onChange={(event) => dispatch({ type: 'setVolume', volume: Number(event.target.value) })} />
            </label>
          </div>
        </Section>
      )}

      <Section title="Saída visual">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={pill(controls.visualMode === 'black')} aria-pressed={controls.visualMode === 'black'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: controls.visualMode === 'black' ? 'normal' : 'black' })}>
            Tela preta
          </button>
          <button type="button" className={pill(controls.visualMode === 'lyricsHidden')} aria-pressed={controls.visualMode === 'lyricsHidden'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: controls.visualMode === 'lyricsHidden' ? 'normal' : 'lyricsHidden' })}>
            Ocultar letra
          </button>
          <button type="button" className={pill(controls.frozen)} aria-pressed={controls.frozen} onClick={() => dispatch({ type: 'setFrozen', frozen: !controls.frozen })}>
            {controls.frozen ? 'Liberar saída' : 'Congelar saída'}
          </button>
        </div>
      </Section>

      <Section title="Recuperar aparência">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={!controls.canUndo} onClick={() => dispatch({ type: 'undo' })}>
            ↶ Desfazer último ajuste
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={!controls.hasVisualOverrides} onClick={() => dispatch({ type: 'restoreAppearance' })}>
            Restaurar aparência preparada
          </button>
        </div>
      </Section>

      {operatorItems}

      {onHideOutputControls && (
        <Section title="Esta tela">
          <button type="button" className={cn(buttonClass('secondary', 'sm'), 'self-start')} onClick={onHideOutputControls}>
            Ocultar controles nesta tela
          </button>
        </Section>
      )}
    </div>
  );
}

export { Section as MenuSection };
