'use client';

import { BUNDLED_FONTS, FONT_SIZE_PX, OCCURRENCE_DURATION_MS, TEXT_ALIGNS, THEME_PRESETS, type TextAlign } from '@louvorvisual/domain';
import { fontStack, type AdjustScope, type ControlsState, type OperatorCommand } from '@louvorvisual/presentation';
import { useState, type ReactNode } from 'react';
import { useFocusLayer } from '@/input/focus';
import { Action, Adjust } from '@/ui/Action';
import { formatSeconds } from './labels';

type Dispatch = (command: OperatorCommand) => void;

type Props = {
  controls: ControlsState;
  dispatch: Dispatch;
  /** Fecha o menu inteiro e devolve o foco à área do slide. */
  onClose: () => void;
  onExit: () => void;
  /** Só dentro de um repertório: troca explícita de louvor. */
  onNextSong?: () => void;
  onPreviousSong?: () => void;
  nextSongTitle?: string;
  previousSongTitle?: string;
};

type SubmenuId = 'tema' | 'fonte' | 'tamanho' | 'tempo' | 'alinhamento' | 'audio' | 'saida';

const ALIGN_LABEL: Record<TextAlign, string> = { left: 'Esquerda', center: 'Centro', right: 'Direita' };
const SCOPE_LABEL: Record<AdjustScope, string> = { occurrence: 'Só este slide', song: 'Todos os slides deste louvor' };
const LINE_HEIGHTS = [1, 1.2, 1.4, 1.6];
const TIMER_STEP_MS = 500;
const TIMER_SUGGESTION_MS = 8000;

function Panel({ name, level, title, scope, onBack, onClose, children }: { name: string; level: number; title: string; scope?: string; onBack: () => void; onClose: () => void; children: ReactNode }) {
  const ref = useFocusLayer({
    name,
    level,
    repeat: 'directions',
    onBack,
    // A tecla Menu alterna o menu: aberta em qualquer nível, fecha tudo sem encerrar a sessão.
    onKey: (key) => {
      if (key !== 'menu') return false;
      onClose();
      return true;
    },
  });
  return (
    <div className="menu" ref={ref} role="dialog" aria-label={title} data-layer={name} data-testid={name}>
      <div className="menu-title">
        {title}
        {scope && <span>{scope}</span>}
      </div>
      <div className="list">{children}</div>
    </div>
  );
}

function Choice({ label, active, onSelect, testId, autoFocus }: { label: string; active: boolean; onSelect: () => void; testId?: string; autoFocus?: boolean }) {
  return (
    <Action className="button check" pressed={active} testId={testId} autoFocus={autoFocus} onSelect={onSelect}>
      {label}
    </Action>
  );
}

function ScopeToggle({ scope, onChange }: { scope: AdjustScope; onChange: (scope: AdjustScope) => void }) {
  return (
    <Action className="button" testId="menu-scope" onSelect={() => onChange(scope === 'song' ? 'occurrence' : 'song')}>
      <span>Aplicar em</span>
      <span className="button-value">{SCOPE_LABEL[scope]}</span>
    </Action>
  );
}

/**
 * Ajustes ao vivo pelo controle (planejamento/20 e 21). Só envia comandos ao
 * motor único da sessão. Tudo aqui é sobre o que está sendo projetado: não há
 * notas, conta, sincronização nem nome de arquivo — o menu aparece na projeção.
 */
export function LiveMenu({ controls, dispatch, onClose, onExit, onNextSong, onPreviousSong, nextSongTitle, previousSongTitle }: Props) {
  const [open, setOpen] = useState<SubmenuId | null>(null);
  // Tema vale, por padrão, para o louvor; fonte e tamanho, para o slide atual.
  const [themeScope, setThemeScope] = useState<AdjustScope>('song');
  const [styleScope, setStyleScope] = useState<AdjustScope>('occurrence');
  const [timerDraft, setTimerDraft] = useState<number>(controls.durationMs ?? TIMER_SUGGESTION_MS);
  const { appearance, audio } = controls;
  const linked = audio?.policy === 'linked';
  const back = () => setOpen(null);
  const sub = (id: SubmenuId, title: string, scope: string | undefined, children: ReactNode) => (
    <Panel name={`menu-${id}`} level={3} title={title} scope={scope} onBack={back} onClose={onClose}>
      {children}
    </Panel>
  );
  const item = (id: SubmenuId, label: string, value: string) => (
    <Action className="button" focusKey={`menu:${id}`} testId={`menu-item-${id}`} autoFocus={id === 'tema'} onSelect={() => setOpen(id)}>
      <span>{label}</span>
      <span className="button-value">{value}</span>
    </Action>
  );
  const themeName = THEME_PRESETS.find((preset) => preset.presetId === appearance.themePresetId)?.name ?? 'Personalizado';
  const fontName = BUNDLED_FONTS.find((font) => font.fontId === appearance.fontId)?.family ?? '';
  const visual = controls.frozen ? 'Congelada' : controls.visualMode === 'black' ? 'Tela preta' : controls.visualMode === 'lyricsHidden' ? 'Letra oculta' : 'Normal';

  return (
    <>
      <Panel name="menu" level={2} title="Ajustes" scope={`${controls.label} · ${controls.index + 1} de ${controls.total}`} onBack={onClose} onClose={onClose}>
        {item('tema', 'Tema', themeName)}
        {item('fonte', 'Fonte', fontName)}
        {item('tamanho', 'Tamanho da letra', `${appearance.fontSizePx} px`)}
        {item('tempo', 'Temporizador deste slide', controls.durationMs === null ? 'Sem tempo' : `${formatSeconds(controls.durationMs)} s`)}
        <Action className="button" testId="menu-mode" onSelect={() => dispatch({ type: 'setMode', mode: controls.mode === 'manual' ? 'automatic' : 'manual' })}>
          <span>Avanço</span>
          <span className="button-value">{controls.mode === 'manual' ? 'Manual' : controls.awaitingManualAdvance ? 'Automático · esperando você' : 'Automático'}</span>
        </Action>
        <Action className="button" testId="menu-rotate" onSelect={() => dispatch({ type: 'rotate' })}>
          <span>Girar a letra</span>
          <span className="button-value">{controls.rotation}°</span>
        </Action>
        {item('alinhamento', 'Alinhamento', ALIGN_LABEL[appearance.textAlign])}
        {audio && item('audio', 'Áudio', (linked ? controls.status === 'running' : audio.playing) ? 'Tocando' : 'Parado')}
        {item('saida', 'Saída visual', visual)}
        <Action className="button" testId="menu-undo" disabled={!controls.canUndo} onSelect={() => dispatch({ type: 'undo' })}>
          Desfazer último ajuste
        </Action>
        <Action className="button" testId="menu-restore" disabled={!controls.hasVisualOverrides} onSelect={() => dispatch({ type: 'restoreAppearance' })}>
          Restaurar aparência preparada
        </Action>
        {onNextSong && (
          <Action className="button" testId="menu-next-song" onSelect={onNextSong}>
            <span>Próximo louvor</span>
            <span className="button-value">{nextSongTitle}</span>
          </Action>
        )}
        {onPreviousSong && (
          <Action className="button" testId="menu-previous-song" onSelect={onPreviousSong}>
            <span>Louvor anterior</span>
            <span className="button-value">{previousSongTitle}</span>
          </Action>
        )}
        <Action className="button" testId="menu-exit" onSelect={onExit}>
          Encerrar apresentação
        </Action>
      </Panel>

      {open === 'tema' &&
        sub(
          'tema',
          'Tema',
          SCOPE_LABEL[themeScope],
          <>
            <ScopeToggle scope={themeScope} onChange={setThemeScope} />
            <div className="menu-grid">
              {THEME_PRESETS.map((preset) => (
                <Action
                  key={preset.presetId}
                  className="swatch"
                  testId={`theme-${preset.presetId}`}
                  pressed={appearance.themePresetId === preset.presetId}
                  autoFocus={appearance.themePresetId === preset.presetId}
                  style={{ backgroundColor: preset.style.palette.backgroundColor, color: preset.style.palette.textColor }}
                  onSelect={() => dispatch({ type: 'adjust', scope: themeScope, patch: { themePresetId: preset.presetId } })}
                >
                  {preset.name}
                </Action>
              ))}
            </div>
          </>,
        )}

      {open === 'fonte' &&
        sub(
          'fonte',
          'Fonte',
          SCOPE_LABEL[styleScope],
          <>
            <ScopeToggle scope={styleScope} onChange={setStyleScope} />
            <div className="menu-grid">
              {BUNDLED_FONTS.map((font) => (
                <Action
                  key={font.fontId}
                  className="swatch"
                  testId={`font-${font.fontId}`}
                  pressed={appearance.fontId === font.fontId}
                  autoFocus={appearance.fontId === font.fontId}
                  style={{ fontFamily: fontStack(font.fontId) }}
                  onSelect={() => dispatch({ type: 'adjust', scope: styleScope, patch: { fontId: font.fontId } })}
                >
                  {font.family}
                </Action>
              ))}
            </div>
            <Choice label="Negrito" active={appearance.fontWeight === 700} testId="font-bold" onSelect={() => dispatch({ type: 'adjust', scope: styleScope, patch: { fontWeight: appearance.fontWeight === 700 ? 400 : 700 } })} />
            {appearance.fontChosen && (
              <Action className="button" testId="font-reset" onSelect={() => dispatch({ type: 'resetAdjustment', scope: styleScope, keys: ['fontId'] })}>
                Usar a fonte inicial do tema
              </Action>
            )}
          </>,
        )}

      {open === 'tamanho' &&
        sub(
          'tamanho',
          'Tamanho da letra',
          SCOPE_LABEL[styleScope],
          <>
            <Adjust label="A−  /  A+" value={`${appearance.fontSizePx} px`} testId="size-adjust" autoFocus onStep={(direction) => dispatch({ type: 'stepFontSize', direction, scope: styleScope })} />
            <p className="menu-note">
              De {FONT_SIZE_PX.min} a {FONT_SIZE_PX.max} px, em passos de {FONT_SIZE_PX.step}.
            </p>
            <ScopeToggle scope={styleScope} onChange={setStyleScope} />
            <Action className="button" testId="size-reset" onSelect={() => dispatch({ type: 'resetAdjustment', scope: styleScope, keys: ['fontSizePx'] })}>
              Tamanho inicial
            </Action>
          </>,
        )}

      {open === 'tempo' &&
        sub(
          'tempo',
          'Temporizador deste slide',
          controls.durationMs === null ? 'Sem tempo' : `${formatSeconds(controls.durationMs)} s`,
          linked ? (
            <>
              <p className="menu-note" data-testid="timer-linked">
                Com a faixa vinculada aos slides, o tempo é revisado no computador.
              </p>
              <Action className="button" autoFocus onSelect={back}>
                Voltar
              </Action>
            </>
          ) : (
            <>
              <Adjust
                label="Tempo"
                value={`${formatSeconds(timerDraft)} s`}
                testId="timer-adjust"
                autoFocus
                onStep={(direction) => setTimerDraft((value) => Math.min(OCCURRENCE_DURATION_MS.max, Math.max(OCCURRENCE_DURATION_MS.min, value + direction * TIMER_STEP_MS)))}
              />
              <Action className="button" testId="timer-apply" onSelect={() => dispatch({ type: 'setDuration', occurrenceId: controls.occurrenceId, durationMs: timerDraft })}>
                Aplicar {formatSeconds(timerDraft)} s
              </Action>
              {controls.durationMs !== null && (
                <Action className="button" testId="timer-remove" onSelect={() => dispatch({ type: 'setDuration', occurrenceId: controls.occurrenceId, durationMs: null })}>
                  Remover tempo
                </Action>
              )}
              <p className="menu-note">Aplicar reinicia a contagem deste slide. Em pausa, continua em pausa.</p>
            </>
          ),
        )}

      {open === 'alinhamento' &&
        sub(
          'alinhamento',
          'Alinhamento',
          SCOPE_LABEL[styleScope],
          <>
            {TEXT_ALIGNS.map((align) => (
              <Choice key={align} label={ALIGN_LABEL[align]} active={appearance.textAlign === align} autoFocus={appearance.textAlign === align} testId={`align-${align}`} onSelect={() => dispatch({ type: 'adjust', scope: styleScope, patch: { textAlign: align } })} />
            ))}
            <Adjust
              label="Entrelinha"
              value={appearance.lineHeight.toLocaleString('pt-BR', { minimumFractionDigits: 1 })}
              testId="line-height-adjust"
              onStep={(direction) => {
                const index = LINE_HEIGHTS.findIndex((value) => value >= appearance.lineHeight - 1e-6);
                const next = LINE_HEIGHTS[(index < 0 ? LINE_HEIGHTS.length - 1 : index) + direction];
                if (next !== undefined) dispatch({ type: 'adjust', scope: styleScope, patch: { lineHeight: next } });
              }}
            />
            <ScopeToggle scope={styleScope} onChange={setStyleScope} />
          </>,
        )}

      {open === 'audio' &&
        audio &&
        sub(
          'audio',
          'Áudio',
          `${audio.kind === 'playback' ? 'Playback' : 'Áudio original'} · ${linked ? 'vinculado aos slides' : 'independente'}`,
          <>
            {/* Vinculada: o play/pause é o da apresentação. O som sai sempre do player único do aparelho. */}
            <Action className="button" testId="audio-toggle" autoFocus disabled={linked && controls.status === 'ready'} onSelect={() => dispatch(linked ? { type: 'toggle' } : { type: 'audioToggle' })}>
              {(linked ? controls.status === 'running' : audio.playing) ? 'Pausar' : 'Tocar'}
            </Action>
            <Adjust label="Volume" value={`${Math.round(audio.volume * 100)} %`} testId="audio-volume" onStep={(direction) => dispatch({ type: 'setVolume', volume: Math.min(1, Math.max(0, Math.round((audio.volume + direction * 0.05) * 100) / 100)) })} />
            <Action className="button" testId="audio-drop" onSelect={() => dispatch({ type: 'dropAudio' })}>
              Continuar sem áudio
            </Action>
          </>,
        )}

      {open === 'saida' &&
        sub(
          'saida',
          'Saída visual',
          visual,
          <>
            <Choice label="Tela preta" active={controls.visualMode === 'black'} autoFocus testId="visual-black" onSelect={() => dispatch({ type: 'setVisualMode', visualMode: controls.visualMode === 'black' ? 'normal' : 'black' })} />
            <Choice label="Ocultar letra" active={controls.visualMode === 'lyricsHidden'} testId="visual-hidden" onSelect={() => dispatch({ type: 'setVisualMode', visualMode: controls.visualMode === 'lyricsHidden' ? 'normal' : 'lyricsHidden' })} />
            <Choice label={controls.frozen ? 'Liberar a imagem' : 'Congelar a imagem'} active={controls.frozen} testId="visual-freeze" onSelect={() => dispatch({ type: 'setFrozen', frozen: !controls.frozen })} />
            <p className="menu-note">O menu continua visível e funcionando com a tela preta ou congelada.</p>
          </>,
        )}
    </>
  );
}
