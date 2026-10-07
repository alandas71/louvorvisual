'use client';

import { touch, type Uuid } from '@louvorvisual/domain';
import { mergeOverridesIntoArrangement, shortcutCommand, type OperatorCommand, type OutputFrame, type ResolvedSlide, type SaveToArrangementResult } from '@louvorvisual/presentation';
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { SlideView } from '@/components/SlideView';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Textarea } from '@/components/ui/Textarea';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { saveDocuments, useLocalSession, type LocalSession, type PresentationSessionRow } from '@/local';
import { useFontFace, useSlideFit } from '@/presentation/measure';
import { AudioPanel, LinkedTiming } from './AudioPanel';
import type { SessionController } from './controller';
import { InteractiveStage } from './InteractiveStage';
import { COMMAND_FAILURE_TEXT, formatSeconds, SAVE_FIELD_TEXT, SNAPSHOT_ISSUE_TEXT, SNAPSHOT_WARNING_TEXT } from './labels';
import { LiveMenu, MenuSection } from './LiveMenu';
import { useOperatorSession, type AudioChoice, type AudioProblem, type SessionWarning, type SetlistPosition } from './useOperatorSession';

/** Volta para de onde a apresentação foi aberta: o repertório ou o editor do louvor. */
function leave(songId: Uuid, arrangementId: Uuid | null, setlistId: Uuid | null) {
  if (setlistId) setLocalQuery({ view: 'repertorios', repertorio: setlistId, song: null, arranjo: null, item: null, sessao: null });
  else setLocalQuery({ view: 'editor', song: songId, arranjo: arrangementId, repertorio: null, item: null, sessao: null });
}

const SESSION_WARNING_TEXT: Record<SessionWarning, string> = {
  ...SNAPSHOT_WARNING_TEXT,
  'prepared-copy-outdated': 'A biblioteca tem uma revisão mais recente deste louvor. Esta apresentação usa a cópia preparada do repertório; prepare o repertório de novo para atualizá-la.',
  'setlist-not-prepared': 'Este repertório ainda não foi preparado para uso offline: a apresentação usa a biblioteca como está agora.',
  'audio-unavailable': 'A faixa de áudio não está disponível neste dispositivo. A apresentação segue sem áudio.',
};

const AUDIO_PROBLEM_TEXT: Record<AudioProblem, string> = {
  'asset-missing': 'O registro do arquivo de áudio deste arranjo não existe mais neste dispositivo.',
  missing: 'O arquivo de áudio deste arranjo não está neste dispositivo.',
  corrupted: 'O arquivo de áudio guardado neste dispositivo está diferente do original (tamanho ou conteúdo não conferem).',
  unplayable: 'Este navegador não conseguiu ler o arquivo de áudio.',
};

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6" data-view="apresentar">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
    </main>
  );
}

/** Área do operador: prepara ou recupera a sessão e mostra o painel. */
export function OperatorView() {
  const query = useLocalQuery();
  const local = useLocalSession();
  const songId = query.get('song');
  if (!songId) {
    return (
      <Notice title="Nenhum louvor escolhido">
        <button type="button" className={buttonClass('secondary', 'md', 'self-start')} onClick={() => setLocalQuery({ view: 'biblioteca', song: null, arranjo: null })}>
          ← Biblioteca
        </button>
      </Notice>
    );
  }
  if (local.status === 'loading') return <p role="status" className="p-6">Preparando a apresentação…</p>;
  if (local.status === 'error') return <p role="alert" className="p-6">{local.message}</p>;
  const setlistId = query.get('repertorio');
  const itemId = query.get('item');
  return (
    <Operator key={`${songId}:${query.get('arranjo') ?? ''}:${setlistId ?? ''}:${itemId ?? ''}`} local={local.session} songId={songId} arrangementId={query.get('arranjo')} setlistId={setlistId} itemId={itemId} sessionHint={query.get('sessao')} />
  );
}

type OperatorProps = { local: LocalSession; songId: Uuid; arrangementId: Uuid | null; setlistId: Uuid | null; itemId: Uuid | null; sessionHint: Uuid | null };

function Operator({ local, songId, arrangementId, setlistId, itemId, sessionHint }: OperatorProps) {
  const state = useOperatorSession(local, { songId, arrangementId, setlistId, itemId, sessionHint });
  const back = (
    <button type="button" className={buttonClass('secondary', 'md', 'self-start')} onClick={() => leave(songId, arrangementId, setlistId)}>
      {setlistId ? '← Voltar ao repertório' : '← Voltar ao editor'}
    </button>
  );

  if (state.status === 'loading') return <p role="status" className="p-6">{state.detail ?? 'Preparando a apresentação…'}</p>;
  if (state.status === 'audio-problem') {
    return (
      <Notice title="A faixa de áudio não pode ser usada">
        <p role="alert" data-testid="audio-problem" data-problem={state.problem}>
          {AUDIO_PROBLEM_TEXT[state.problem]}
          {state.filename ? ` Arquivo: ${state.filename}.` : ''} A apresentação não começa com esta faixa.
        </p>
        <p className="text-sm text-muted">Para usar o áudio, volte ao editor do louvor e importe o arquivo de novo. Ou siga agora, só com os slides.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass('primary')} onClick={state.continueWithoutAudio}>
            Seguir sem áudio
          </button>
          <button type="button" className={buttonClass('secondary')} onClick={() => setLocalQuery({ view: 'editor', song: songId, arranjo: arrangementId, repertorio: null, item: null })}>
            Abrir o editor para importar o áudio
          </button>
        </div>
        {setlistId && back}
      </Notice>
    );
  }
  if (state.status === 'missing') return <Notice title="Louvor não encontrado">{back}</Notice>;
  if (state.status === 'invalid') {
    return (
      <Notice title="Não foi possível preparar a apresentação">
        {state.issues.map((issue) => (
          <p key={issue} role="alert">
            {SNAPSHOT_ISSUE_TEXT[issue]}
          </p>
        ))}
        {back}
      </Notice>
    );
  }
  if (state.status === 'blocked') {
    return (
      <Notice title="Já existe um painel de operador aberto">
        <p role="alert" data-testid="controller-blocked">
          Outra janela ou aba deste dispositivo está controlando uma apresentação. Só um painel controla a projeção por vez; feche o outro
          para usar este.
        </p>
        {back}
      </Notice>
    );
  }
  if (state.status === 'recoverable') {
    return (
      <Notice title="Recuperar apresentação?">
        <p data-testid="recover-prompt">
          A apresentação de &ldquo;{state.title}&rdquo; foi interrompida{state.savedAt ? ` (último registro às ${new Date(state.savedAt).toLocaleTimeString('pt-BR')})` : ''}. Ela volta em
          pausa, no mesmo slide e com os ajustes que já estavam guardados.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass('primary')} onClick={state.recover}>
            Recuperar apresentação
          </button>
          <button type="button" className={buttonClass('secondary')} onClick={state.restart}>
            Começar de novo
          </button>
        </div>
        {back}
      </Notice>
    );
  }
  return (
    <OperatorPanel
      local={local}
      controller={state.controller}
      row={state.row}
      warnings={state.warnings.map((warning) => SESSION_WARNING_TEXT[warning])}
      recovered={state.recovered}
      audioChoices={state.audioChoices}
      onChooseAudio={state.chooseAudio}
      setlist={state.setlist}
      onEnd={() => void state.end().then(() => leave(songId, state.row.arrangementId, setlistId))}
      onNextSong={(next) => {
        // A janela de projeção é avisada de qual sessão vem a seguir e continua armada, em preto, até ela começar.
        const nextSessionId = crypto.randomUUID();
        void state.end(nextSessionId).then(() => setLocalQuery({ view: 'apresentar', song: next.songId, arranjo: next.arrangementId, repertorio: setlistId, item: next.itemId, sessao: nextSessionId }));
      }}
    />
  );
}

/**
 * Contagem regressiva do operador: lê o relógio do motor a cada desenho; não é
 * outro relógio. O intervalo só pede um novo desenho, então um salto ou uma
 * pausa aparecem na mesma hora, sem mostrar o valor do slide anterior.
 */
function Countdown({ controller, className }: { controller: SessionController; className?: string }) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(redraw, 100);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = controller.engine.remainingMs();
  if (remaining === null) return null;
  return (
    <span className={cn('tabular-nums', className)} data-testid="countdown" data-remaining-ms={Math.round(remaining)}>
      {formatSeconds(Math.ceil(remaining / 100) * 100)} s
    </span>
  );
}

const OUTPUT_LABEL = { normal: 'Letra visível', black: 'Tela preta', lyricsHidden: 'Letra oculta' } as const;

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable));
}

type PanelProps = {
  local: LocalSession;
  controller: SessionController;
  row: PresentationSessionRow;
  warnings: string[];
  recovered: boolean;
  audioChoices: AudioChoice[];
  onChooseAudio: (bindingId: Uuid | null) => void;
  setlist: SetlistPosition | null;
  onEnd: () => void;
  onNextSong: (next: NonNullable<SetlistPosition['next']>) => void;
};

function OperatorPanel({ local, controller, row, warnings, recovered, audioChoices, onChooseAudio, setlist, onEnd, onNextSong }: PanelProps) {
  const { view, link, checkpoint, wakeLock, lastConfirmMs } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { state, controls, current, next, slides, output } = view;
  const [interactive, setInteractive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [draft, setDraft] = useState<{ occurrenceId: Uuid; text: string } | null>(null);
  const [baseArrangement, setBaseArrangement] = useState(row.baseArrangement);
  const [saveResult, setSaveResult] = useState<SaveToArrangementResult | { error: string } | null>(null);

  const dispatch = useCallback(
    (command: OperatorCommand) => {
      const result = controller.execute(command);
      setMessage(result.ok ? null : COMMAND_FAILURE_TEXT[result.reason]);
    },
    [controller],
  );

  // Atalhos do operador; ignorados em campos de edição e com modificadores.
  const controlsRef = useRef(controls);
  useEffect(() => {
    controlsRef.current = controls;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditable(event.target)) return;
      // Em um botão, Espaço é o clique do próprio botão.
      if (event.key === ' ' && (event.target as HTMLElement | null)?.closest('button, a, [role="button"]')) return;
      const command = shortcutCommand(event, controlsRef.current);
      if (!command) return;
      event.preventDefault();
      dispatch(command);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  function openProjection() {
    // Aberta por clique direto; a janela pública nunca é criada sozinha.
    const opened = window.open(`/projecao?session=${encodeURIComponent(row.id)}`, 'lv-projecao', 'popup,width=1280,height=720');
    setPopupBlocked(opened === null);
  }

  async function saveToArrangement() {
    setSaveResult(null);
    try {
      const latest = await local.db.arrangements.get(row.arrangementId);
      if (!latest || latest.deletedAt !== null) {
        setSaveResult({ error: 'O arranjo não existe mais na biblioteca; os ajustes continuam só nesta sessão.' });
        return;
      }
      const result = mergeOverridesIntoArrangement(baseArrangement, controller.engine.getOverrides(), latest);
      if (result.changed) {
        const saved = touch(result.arrangement, local.context());
        await saveDocuments(local.db, [{ entityType: 'arrangement', document: saved }]);
        // Os campos gravados passam a ser a nova base de comparação desta sessão.
        await local.db.presentationSessions.update(row.id, { baseArrangement: saved });
        setBaseArrangement(saved);
      }
      setSaveResult(result);
    } catch (error) {
      setSaveResult({ error: error instanceof Error ? error.message : 'Não foi possível gravar no arranjo.' });
    }
  }

  const frozenDiffers = state.frozenOutput && (output.occurrenceId !== current.occurrenceId || output.overridesRevision !== state.overridesRevision);
  const projectionText =
    link.connection === 'none'
      ? 'Janela de projeção fechada.'
      : link.connection === 'lost'
        ? 'A janela de projeção não está respondendo. Reabrir projeção.'
        : link.armed
          ? 'Projeção conectada.'
          : 'Projeção conectada; falta armar a saída na própria janela.';

  // Com faixa vinculada, o tempo é revisado em rascunho privado; nunca aplicado direto.
  const linkedTiming =
    controls.audio?.policy === 'linked' && row.snapshot.audio ? (
      <LinkedTiming slides={slides} currentId={current.occurrenceId} audio={row.snapshot.audio} status={state.status} dispatch={dispatch} />
    ) : undefined;
  const timed = state.mode === 'automatic' && controls.durationMs !== null;
  // O play/pause age só na faixa quando ela é independente e não há relógio de slide em jogo.
  const audioOnly = controls.audio?.policy === 'independent' && !timed;
  const transportLabel = audioOnly
    ? controls.audio?.playing
      ? '❚❚ Pausar faixa'
      : '▶ Tocar faixa'
    : state.status === 'running'
      ? '❚❚ Pausar'
      : state.status === 'paused'
        ? '▶ Retomar'
        : '▶ Recomeçar este slide';

  const operatorItems = (
    <>
      <TextDraft key={current.occurrenceId} slide={current} draft={draft?.occurrenceId === current.occurrenceId ? draft.text : null} frozen={state.frozenOutput} onDraft={(text) => setDraft(text === null ? null : { occurrenceId: current.occurrenceId, text })} onApply={(text) => {
        dispatch({ type: 'applyText', occurrenceId: current.occurrenceId, text });
        setDraft(null);
      }} />
      <MenuSection title="Guardar ajustes">
        <p className="text-xs text-muted">Os ajustes valem só para esta sessão. Salvar leva para o arranjo os campos alterados; rotação da saída não é gravada.</p>
        <button type="button" className={cn(buttonClass('secondary', 'sm'), 'self-start')} disabled={state.overridesRevision === 0} onClick={() => void saveToArrangement()}>
          Salvar ajustes no arranjo
        </button>
        {saveResult && <SaveSummary result={saveResult} />}
      </MenuSection>
    </>
  );

  const rootAttributes = {
    'data-testid': 'operator',
    'data-session-id': row.id,
    'data-status': state.status,
    'data-mode': state.mode,
    'data-index': state.currentIndex,
    'data-occurrence-id': state.currentOccurrenceId,
    'data-sequence': state.sequenceNumber,
    'data-awaiting': state.awaitingManualAdvance,
    'data-visual-mode': state.visualMode,
    'data-frozen': state.frozenOutput,
    'data-rotation': view.rotation,
    'data-overrides-revision': state.overridesRevision,
    'data-checkpoint': checkpoint,
    'data-projection': link.connection,
    'data-projection-armed': link.armed,
    'data-projection-font-missing': link.fontMissing,
    'data-confirmed-sequence': link.confirmedSequence ?? '',
    'data-last-confirm-ms': lastConfirmMs === null ? '' : Math.round(lastConfirmMs),
    'data-interactive': interactive,
    'data-audio-policy': state.audioPolicy,
    'data-audio-playing': controls.audio?.playing ?? false,
    'data-audio-seeking': controls.audio?.seeking ?? false,
    'data-clock-source': state.clockSource,
    'data-notice': view.notice ?? '',
    'data-wake-lock': wakeLock,
  };

  if (interactive) {
    return (
      <main id="main-content" className="h-dvh w-full bg-black" data-view="apresentar" {...rootAttributes}>
        <InteractiveStage
          frame={view.live}
          rotation={view.rotation}
          controls={controls}
          dispatch={dispatch}
          countdown={controls.capabilities.countdown ? <Countdown controller={controller} /> : undefined}
          pinned={draft !== null}
          badge={
            <span className="flex items-center gap-2 text-xs text-[rgba(209,213,219,0.9)]">
              {state.frozenOutput && <span data-testid="stage-frozen">Saída congelada</span>}
              <button type="button" className="rounded-lg border border-[rgba(209,213,219,0.35)] px-2 py-2 hover:border-[rgba(209,213,219,0.9)] focus-visible:outline-2 focus-visible:outline-[#D1D5DB]" onClick={() => setInteractive(false)}>
                Painel completo
              </button>
            </span>
          }
          operatorItems={operatorItems}
          linkedTiming={linkedTiming}
        />
      </main>
    );
  }

  return (
    <main id="main-content" className="flex min-h-dvh flex-col gap-4 p-4" data-view="apresentar" {...rootAttributes}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{row.snapshot.song.title}</h1>
          <p className="text-sm text-muted">
            {row.snapshot.arrangement.name} · slide {state.currentIndex + 1} de {slides.length}
            {recovered && ' · sessão recuperada'}
            {setlist && ` · ${setlist.title}: louvor ${setlist.index + 1} de ${setlist.total}`}
          </p>
        </div>
        {setlist?.next && (
          // Trocar de louvor é sempre uma ação do operador; o próximo abre preparado, sem tocar.
          <button type="button" className={buttonClass('secondary', 'sm')} data-testid="next-song" onClick={() => onNextSong(setlist.next as NonNullable<SetlistPosition['next']>)}>
            Próximo louvor: {setlist.next.title} →
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Modo de avanço">
          <button type="button" className={cn(buttonClass('secondary', 'sm'), state.mode === 'manual' && 'border-accent text-accent')} aria-pressed={state.mode === 'manual'} onClick={() => dispatch({ type: 'setMode', mode: 'manual' })}>
            Manual
          </button>
          <button type="button" className={cn(buttonClass('secondary', 'sm'), state.mode === 'automatic' && 'border-accent text-accent')} aria-pressed={state.mode === 'automatic'} onClick={() => dispatch({ type: 'setMode', mode: 'automatic' })}>
            Automático
          </button>
        </div>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={openProjection}>
          {link.connection === 'connected' ? 'Reabrir janela de projeção' : 'Abrir janela de projeção'}
        </button>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setInteractive(true)}>
          Modo interativo
        </button>
        <button type="button" className={buttonClass('danger', 'sm')} onClick={onEnd}>
          Encerrar
        </button>
      </header>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <p role="status" data-testid="projection-status" data-connection={link.connection} className={link.connection === 'lost' ? 'font-semibold text-danger' : 'text-muted'}>
          {link.connection === 'lost' ? '⚠ ' : link.connection === 'connected' ? '● ' : '○ '}
          {projectionText}
        </p>
        <p role="status" data-testid="checkpoint-status" data-state={checkpoint} className={checkpoint === 'memory-only' ? 'font-semibold text-danger' : 'text-muted'}>
          {checkpoint === 'saved' && '✓ Guardado nesta sessão'}
          {checkpoint === 'saving' && 'Guardando…'}
          {checkpoint === 'memory-only' && '⚠ Não foi possível gravar: o ajuste está apenas em memória.'}
        </p>
      </div>

      {link.fontMissing && (
        <p role="alert" data-testid="projection-font-missing" className="text-sm text-danger">
          ⚠ A janela de projeção não conseguiu carregar o arquivo da fonte deste slide e está usando a fonte de reserva. Escolha Inter ou outra
          fonte no menu.
        </p>
      )}
      {popupBlocked && (
        <p role="alert" className="text-sm text-danger">
          O navegador bloqueou a nova janela. Permita pop-ups para este endereço e clique de novo.
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} role="alert" data-testid="session-warning" className="text-sm text-danger">
          ⚠ {warning}
        </p>
      ))}
      {view.notice === 'suspension-detected' && (
        <p role="alert" data-testid="suspension-notice" className="rounded-lg border border-danger p-3 text-sm">
          O computador ou a aba ficou suspenso durante a apresentação. Ela foi pausada neste slide, com a faixa parada, sem pular os slides que
          venceram. Retome quando quiser ou navegue para onde a música está.
        </p>
      )}
      {wakeLock === 'released' && state.status === 'running' && (
        <p role="status" data-testid="wake-lock-lost" className="text-sm text-muted">
          O navegador não está mantendo a tela acordada. Deixe esta janela visível e desative a suspensão automática do computador durante o culto.
        </p>
      )}
      {message && (
        <p role="status" data-testid="operator-message" className="text-sm text-muted">
          {message}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(16rem,22rem)]">
        <section aria-labelledby="atual" className="flex flex-col gap-2">
          <h2 id="atual" className="text-sm font-semibold text-muted">
            Slide atual · {current.label || 'Sem rótulo'}
          </h2>
          <div data-testid="current-slide">
            <SlideView text={current.text} style={current.style} fontId={current.fontId} className="w-full rounded-lg border border-border" />
          </div>
          <SlideChecks slide={current} />
          <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="timing">
            {controls.capabilities.timerIndicator && controls.durationMs !== null && (
              <span data-testid="timer-indicator" data-duration-ms={controls.durationMs}>
                ⏱ {formatSeconds(controls.durationMs)} s
              </span>
            )}
            {controls.capabilities.countdown && (
              <span>
                faltam <Countdown controller={controller} className="font-semibold" />
              </span>
            )}
            {state.awaitingManualAdvance && <span data-testid="awaiting-advance">Sem tempo neste slide: aguardando você avançar.</span>}
            {state.mode === 'manual' && state.status !== 'ready' && <span className="text-muted">Avanço manual.</span>}
            {state.status === 'ready' && <span className="text-muted">Pronta. O público vê preto até você iniciar.</span>}
            {state.status === 'paused' && <span className="font-semibold">Em pausa.</span>}
            {state.status === 'finished' && <span className="font-semibold">Fim da sequência.</span>}
          </div>
          <AudioPanel controller={controller} view={view} dispatch={dispatch} choices={audioChoices} selectedBindingId={row.snapshot.audio?.bindingId ?? null} onChoose={onChooseAudio} />
        </section>

        <section aria-labelledby="lado" className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <h2 id="lado" className="text-sm font-semibold text-muted">
              O público vê agora
            </h2>
            <PublicPreview frame={output} rotation={view.rotation} />
            <p className="text-xs" data-testid="public-summary">
              {state.status === 'ready' ? 'Preto (aguardando iniciar)' : OUTPUT_LABEL[output.visualMode]}
              {state.frozenOutput && ' · congelada'}
              {frozenDiffers && ' · diferente do slide atual'}
            </p>
          </div>
          {row.snapshot.song.notes.trim() !== '' && (
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-muted">Notas privadas</h2>
              <p className="whitespace-pre-line text-sm" data-testid="private-notes">
                {row.snapshot.song.notes}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted">Próximo slide{next ? ` · ${next.label || 'Sem rótulo'}` : ''}</h2>
            {next ? (
              <div data-testid="next-slide">
                <SlideView text={next.text} style={next.style} fontId={next.fontId} className="w-full rounded-lg border border-border" />
              </div>
            ) : (
              <p className="text-sm text-muted">Este é o último slide.</p>
            )}
          </div>
        </section>

        {/* Coluna privada: nada daqui é enviado à janela de projeção. */}
        <aside aria-label="Ajustes ao vivo" className="max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-surface-raised p-3">
          <LiveMenu controls={controls} dispatch={dispatch} operatorItems={operatorItems} linkedTiming={linkedTiming} />
        </aside>
      </div>

      <ol className="flex gap-2 overflow-x-auto pb-2" aria-label="Slides da apresentação">
        {slides.map((slide, index) => (
          <li key={slide.occurrenceId} className="w-40 shrink-0">
            <button
              type="button"
              data-testid="thumbnail"
              data-occurrence-id={slide.occurrenceId}
              aria-current={index === state.currentIndex ? 'true' : undefined}
              aria-label={`Ir para o slide ${index + 1}: ${slide.label || 'sem rótulo'}`}
              onClick={() => dispatch({ type: 'goTo', occurrenceId: slide.occurrenceId })}
              className={cn(
                'flex w-full flex-col gap-1 rounded-lg border p-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                index === state.currentIndex ? 'border-accent' : 'border-border',
              )}
            >
              <SlideView text={slide.text} style={slide.style} fontId={slide.fontId} className="w-full rounded" />
              <span className="flex justify-between gap-1">
                <span className="truncate">
                  {index + 1} · {slide.label || 'Sem rótulo'}
                </span>
                <span className="shrink-0 text-muted" data-testid="thumbnail-duration" data-duration-ms={slide.durationMs ?? 'null'}>
                  {slide.durationMs === null ? 'sem tempo' : `${formatSeconds(slide.durationMs)} s`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* Sempre à vista: em telas baixas (notebook de 768 px) Iniciar, Avançar e Tela preta ficavam abaixo da dobra. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-auto flex flex-col gap-2 border-t border-border bg-surface px-4 py-3" data-testid="operator-controls">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Controle da apresentação">
          <button type="button" className={buttonClass('secondary')} onClick={() => dispatch({ type: 'previous' })}>
            ← Voltar
          </button>
          {state.status === 'ready' && (
            <button type="button" className={buttonClass('primary')} onClick={() => dispatch({ type: 'start' })}>
              ▶ Iniciar
            </button>
          )}
          {/* Sem duração atual no automático e sem faixa, não existe play/pause. */}
          {controls.capabilities.transport && (
            <button type="button" className={buttonClass('primary')} data-testid="transport" onClick={() => dispatch({ type: 'toggle' })}>
              {transportLabel}
            </button>
          )}
          <button type="button" className={buttonClass('secondary')} onClick={() => dispatch({ type: 'next' })}>
            Avançar →
          </button>
          <span className="mx-2 h-6 w-px bg-border" aria-hidden="true" />
          <button type="button" className={cn(buttonClass('secondary'), state.visualMode === 'black' && 'border-accent text-accent')} aria-pressed={state.visualMode === 'black'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: state.visualMode === 'black' ? 'normal' : 'black' })}>
            Tela preta
          </button>
          <button type="button" className={cn(buttonClass('secondary'), state.visualMode === 'lyricsHidden' && 'border-accent text-accent')} aria-pressed={state.visualMode === 'lyricsHidden'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: state.visualMode === 'lyricsHidden' ? 'normal' : 'lyricsHidden' })}>
            Ocultar letra
          </button>
          <button type="button" className={cn(buttonClass('secondary'), state.frozenOutput && 'border-accent text-accent')} aria-pressed={state.frozenOutput} onClick={() => dispatch({ type: 'setFrozen', frozen: !state.frozenOutput })}>
            {state.frozenOutput ? 'Liberar saída' : 'Congelar'}
          </button>
          {state.status !== 'ready' && (
            <button type="button" className={buttonClass('secondary')} onClick={() => dispatch({ type: 'stop' })}>
              ■ Parar
            </button>
          )}
        </div>
        <p className="text-xs text-muted">
          Atalhos: → ou Page Down avança · ← ou Page Up volta · Espaço inicia, pausa ou retoma · B tela preta · L oculta a letra · C congela · Home vai ao
          primeiro slide.
        </p>
      </div>
    </main>
  );
}

/** O que a janela pública está mostrando, com a rotação da saída. */
function PublicPreview({ frame, rotation }: { frame: OutputFrame; rotation: 0 | 90 | 180 | 270 }) {
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-border" data-testid="public-preview" data-occurrence-id={frame.occurrenceId}>
      <SlideView fit="fill" text={frame.slide.text} style={frame.slide.style} fontId={frame.slide.fontId} visualMode={frame.visualMode} rotation={rotation} />
    </div>
  );
}

/** Avisos de legibilidade do slide atual: fonte que falhou e texto que não cabe. */
function SlideChecks({ slide }: { slide: ResolvedSlide }) {
  const font = useFontFace(slide.fontId, slide.style.fontWeight);
  const fit = useSlideFit(slide);
  return (
    <>
      {font === 'missing' && (
        <p role="alert" data-testid="font-missing" className="text-sm text-danger">
          ⚠ O arquivo desta fonte não pôde ser carregado; a saída está usando a fonte de reserva do sistema. Escolha Inter ou outra fonte no menu
          e confira as quebras.
        </p>
      )}
      {fit?.overflows && (
        <p role="alert" data-testid="slide-overflow" className="text-sm text-danger">
          ⚠ O texto não cabe com esta letra ({fit.visualLines} linhas na tela, cabem {fit.capacity}). Reduza com A− ou divida o slide no editor.
        </p>
      )}
      {fit && !fit.overflows && fit.exceedsSuggested && (
        <p data-testid="slide-many-lines" className="text-sm text-muted">
          Este slide ocupa {fit.visualLines} linhas na tela; o sugerido são até quatro.
        </p>
      )}
    </>
  );
}

type TextDraftProps = { slide: ResolvedSlide; draft: string | null; frozen: boolean; onDraft: (text: string | null) => void; onApply: (text: string) => void };

/** Rascunho privado do texto: nada vai para a saída antes de "Aplicar ao vivo". */
function TextDraft({ slide, draft, frozen, onDraft, onApply }: TextDraftProps) {
  return (
    <MenuSection title="Editar texto atual">
      {draft === null ? (
        <button type="button" className={cn(buttonClass('secondary', 'sm'), 'self-start')} onClick={() => onDraft(slide.text)}>
          Abrir rascunho do texto
        </button>
      ) : (
        <div className="flex flex-col gap-2" data-testid="text-draft">
          <label htmlFor="rascunho-texto" className="text-xs font-semibold text-muted">
            Rascunho (só você vê)
          </label>
          <Textarea id="rascunho-texto" autoFocus rows={Math.max(3, draft.split('\n').length + 1)} spellCheck={false} value={draft} onChange={(event) => onDraft(event.target.value)} />
          <div data-testid="draft-preview">
            <SlideView text={draft} style={slide.style} fontId={slide.fontId} className="w-full rounded border border-border" />
          </div>
          <DraftFit slide={{ ...slide, text: draft }} />
          {frozen && <p className="text-xs text-muted">A saída está congelada: o texto aplicado aparece para o público quando você liberar.</p>}
          <div className="flex gap-2">
            <button type="button" className={buttonClass('primary', 'sm')} disabled={draft === slide.text} onClick={() => onApply(draft)}>
              Aplicar ao vivo
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => onDraft(null)}>
              Descartar
            </button>
          </div>
        </div>
      )}
    </MenuSection>
  );
}

function DraftFit({ slide }: { slide: ResolvedSlide }) {
  const fit = useSlideFit(slide);
  if (!fit?.overflows) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      O rascunho não cabe com a letra atual ({fit.visualLines} linhas, cabem {fit.capacity}).
    </p>
  );
}

function SaveSummary({ result }: { result: SaveToArrangementResult | { error: string } }) {
  if ('error' in result) {
    return (
      <p role="alert" className="text-xs text-danger" data-testid="save-arrangement" data-state="error">
        {result.error}
      </p>
    );
  }
  const list = (fields: SaveToArrangementResult['applied']) => [...new Set(fields.map((item) => SAVE_FIELD_TEXT[item.field]))].join(', ');
  return (
    <div role="status" className="flex flex-col gap-1 text-xs" data-testid="save-arrangement" data-state={result.changed ? 'saved' : 'unchanged'} data-applied={result.applied.length} data-conflicts={result.conflicts.length} data-skipped={result.skipped.length}>
      {result.applied.length > 0 ? <p>✓ Salvo no arranjo: {list(result.applied)}.</p> : <p>Nada foi gravado no arranjo.</p>}
      {result.conflicts.length > 0 && <p className="text-danger">Não sobrescrito, porque o arranjo mudou na biblioteca depois da preparação: {list(result.conflicts)}.</p>}
      {result.skipped.length > 0 && <p className="text-muted">Continua só nesta sessão (o arranjo não guarda por slide, ou o slide não existe mais): {list(result.skipped)}.</p>}
    </div>
  );
}
