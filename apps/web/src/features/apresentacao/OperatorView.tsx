'use client';

import { touch, type Uuid } from '@louvorvisual/domain';
import { mergeOverridesIntoArrangement, shortcutCommand, type OperatorCommand, type OutputFrame, type ResolvedSlide, type SaveToArrangementResult } from '@louvorvisual/presentation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { SlideView } from '@/components/SlideView';
import { buttonClass, pressedClass } from '@/components/ui/buttonStyles';
import { Loading, noticeClass, pillClass } from '@/components/ui/PageHeader';
import { Textarea } from '@/components/ui/Textarea';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { readAssetBlob, saveDocuments, useLocalSession, type LocalSession, type PresentationSessionRow } from '@/local';
import { useFontFace, useSlideFit } from '@/presentation/measure';
import { firstVoiceMs } from '../audio/firstVoice';
import { AudioPanel, LinkedTiming } from './AudioPanel';
import type { SessionController } from './controller';
import { CloseIcon, ExpandIcon, MenuIcon, PreviousIcon } from './icons';
import { InteractiveStage } from './InteractiveStage';
import { COMMAND_FAILURE_TEXT, formatSeconds, SAVE_FIELD_TEXT, SNAPSHOT_ISSUE_TEXT, SNAPSHOT_WARNING_TEXT } from './labels';
import { LiveMenu, MenuSection, ModeButtons } from './LiveMenu';
import { useOperatorSession, type AudioChoice, type AudioProblem, type SessionWarning, type SetlistPosition } from './useOperatorSession';

/** Ao encerrar, a pessoa volta sempre à lista principal de louvores. */
function leave() {
  setLocalQuery({ view: 'biblioteca', song: null, arranjo: null, repertorio: null, item: null, sessao: null });
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
    <main id="main-content" className="lv-stage flex min-h-dvh items-center justify-center p-4" data-view="apresentar">
      <div className="flex w-full max-w-xl flex-col gap-4 rounded-3xl border border-border bg-surface-raised p-6 leading-relaxed shadow-pop sm:p-8">
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Preparing({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Loading>{children}</Loading>
    </div>
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
  if (local.status === 'loading') return <Preparing>Preparando a apresentação…</Preparing>;
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
    <button type="button" className={buttonClass('secondary', 'md', 'self-start')} onClick={leave}>
      ← Biblioteca
    </button>
  );

  if (state.status === 'loading') return <Preparing>{state.detail ?? 'Preparando a apresentação…'}</Preparing>;
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
  return (
    <OperatorPanel
      local={local}
      controller={state.controller}
      row={state.row}
      warnings={state.warnings.map((warning) => SESSION_WARNING_TEXT[warning])}
      audioChoices={state.audioChoices}
      onChooseAudio={state.chooseAudio}
      setlist={state.setlist}
      onEnd={() => void state.end().then(leave)}
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

const COMPACT_QUERY = '(max-width: 1023px)';

function subscribeCompact(onChange: () => void) {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** Celular e tablet em pé: painel enxuto, com o slide no centro e os ajustes atrás do menu. */
function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribeCompact, () => window.matchMedia(COMPACT_QUERY).matches, () => false);
}

/** Quanto antes da primeira voz da faixa o botão "Letra →" começa a chamar o operador. */
const VOICE_CUE_LEAD_MS = 1000;

/**
 * Na abertura, com a faixa tocando: `true` a partir de 1 s antes de a letra
 * começar a ser cantada. A faixa é analisada uma vez, em segundo plano; sem
 * faixa, sem a letra reconhecida ou sem conseguir analisar, o aviso
 * simplesmente não aparece.
 */
function useVoiceCue(local: LocalSession, controller: SessionController, row: PresentationSessionRow, lyrics: string, enabled: boolean, armed: boolean): boolean {
  const audio = row.snapshot.audio;
  const workspaceId = row.snapshot.workspaceId;
  const sha256 = audio?.sha256 ?? null;
  const [voice, setVoice] = useState<{ sha256: string; lyrics: string; startMs: number } | null>(null);
  const [due, setDue] = useState(false);

  // A análise começa assim que o painel abre, para estar pronta quando a faixa tocar.
  useEffect(() => {
    if (!enabled || sha256 === null) return;
    let current = true;
    void (async () => {
      const blob = await readAssetBlob(local.db, workspaceId, sha256);
      if (!blob) return;
      const startMs = await firstVoiceMs(blob, sha256, lyrics);
      if (current && startMs !== null) setVoice({ sha256, lyrics, startMs });
    })().catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, local, workspaceId, sha256, lyrics]);

  const startMs = voice && voice.sha256 === sha256 && voice.lyrics === lyrics ? voice.startMs : null;
  useEffect(() => {
    if (!armed || startMs === null) return;
    const check = () => {
      const position = controller.engine.audioPositionMs();
      setDue(position !== null && position >= startMs - VOICE_CUE_LEAD_MS);
    };
    check();
    const timer = window.setInterval(check, 100);
    return () => {
      window.clearInterval(timer);
      setDue(false);
    };
  }, [armed, controller, startMs]);

  return armed && due;
}

type PanelProps = {
  local: LocalSession;
  controller: SessionController;
  row: PresentationSessionRow;
  warnings: string[];
  audioChoices: AudioChoice[];
  onChooseAudio: (bindingId: Uuid | null) => void;
  setlist: SetlistPosition | null;
  onEnd: () => void;
  onNextSong: (next: NonNullable<SetlistPosition['next']>) => void;
};

function OperatorPanel({ local, controller, row, warnings, audioChoices, onChooseAudio, setlist, onEnd, onNextSong }: PanelProps) {
  const { view, link, checkpoint, wakeLock, lastConfirmMs } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { state, controls, current, next, slides, output } = view;
  const compact = useCompactLayout();
  const [interactive, setInteractive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // No celular, na abertura, o botão de avançar é "Letra →" e chama o operador quando a voz da faixa vai entrar.
  const lyricsCue = compact && state.cover;
  // A letra preparada da sessão, sem os ajustes de texto ao vivo: é com ela que a faixa é comparada.
  const lyrics = useMemo(() => row.snapshot.occurrences.map((occurrence) => occurrence.text).join('\n'), [row.snapshot]);
  // No automático a letra entra pelo temporizador da introdução: não há o que detectar nem para quem avisar.
  const introTimed = state.mode === 'automatic' && controls.intro?.auto === true;
  const voiceCue = useVoiceCue(local, controller, row, lyrics, compact && !introTimed, lyricsCue && !introTimed && Boolean(controls.audio?.playing));
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

  // O menu de ajustes do celular fecha com Esc e some ao voltar para a tela larga.
  const settingsOpen = compact && menuOpen;
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  function openProjection() {
    // Aberta por clique direto; a janela pública nunca é criada sozinha.
    const opened = window.open(`/projecao?session=${encodeURIComponent(row.id)}`, 'lv-projecao', 'popup,width=1280,height=720');
    setPopupBlocked(opened === null);
  }

  async function saveToArrangement(options: { setDefaultModeAutomatic?: boolean } = {}) {
    setSaveResult(null);
    try {
      const latest = await local.db.arrangements.get(row.arrangementId);
      if (!latest || latest.deletedAt !== null) {
        setSaveResult({ error: 'O arranjo não existe mais na biblioteca; os ajustes continuam só nesta sessão.' });
        return;
      }
      const result = mergeOverridesIntoArrangement(baseArrangement, controller.engine.getOverrides(), latest, options);
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

  async function saveAssistedTiming() {
    const result = controller.execute({ type: 'completeManualTiming' });
    if (!result.ok) {
      setMessage(COMMAND_FAILURE_TEXT[result.reason]);
      return;
    }
    setMessage(null);
    await saveToArrangement({ setDefaultModeAutomatic: true });
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
  // Na abertura, o que vem a seguir é o primeiro slide da letra.
  const upcoming = state.cover ? current : next;
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
    'data-cover': state.cover,
    'data-intro-ms': controls.intro?.durationMs ?? '',
    'data-intro-auto': controls.intro?.auto ?? false,
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
          onExit={() => setInteractive(false)}
          pinned={draft !== null}
          badge={
            <span className="flex items-center gap-2 text-xs text-[rgba(209,213,219,0.9)]">
              {state.frozenOutput && <span data-testid="stage-frozen">Saída congelada</span>}
              <button type="button" className="rounded-lg border border-danger px-2 py-2 text-danger hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-danger" onClick={onEnd}>
                Sair
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
    <main id="main-content" className="flex min-h-dvh flex-col gap-3 p-3 sm:p-4 lg:h-dvh lg:overflow-hidden" data-view="apresentar" {...rootAttributes}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border bg-surface-raised px-4 py-3 shadow-card max-lg:px-2 max-lg:py-2">
        {compact && (
          // No celular não há botão "Encerrar": voltar fecha a sessão e devolve ao repertório ou ao editor.
          <button type="button" className={buttonClass('ghost', 'sm', 'min-h-11 min-w-11 px-2')} aria-label="Encerrar e voltar" title="Encerrar e voltar" onClick={onEnd}>
            <PreviousIcon />
          </button>
        )}
        <div className="min-w-0 flex-1 basis-56 max-lg:basis-0">
          <h1 className="truncate text-xl font-bold max-lg:text-base">{row.snapshot.song.title}</h1>
          <p className="truncate text-sm text-muted max-lg:text-xs">
            {row.snapshot.arrangement.name} · {state.cover ? 'abertura' : `slide ${state.currentIndex + 1} de ${slides.length}`}
            {setlist && ` · ${setlist.title}: louvor ${setlist.index + 1} de ${setlist.total}`}
          </p>
        </div>
        {compact && (
          <button type="button" className={buttonClass('ghost', 'sm', 'min-h-11 min-w-11 px-2')} aria-label="Abrir ajustes" title="Abrir ajustes" aria-haspopup="dialog" aria-expanded={settingsOpen} data-testid="operator-menu" onClick={() => setMenuOpen(true)}>
            <MenuIcon />
          </button>
        )}
        {setlist?.next && (
          // Trocar de louvor é sempre uma ação do operador; o próximo abre preparado, sem tocar.
          <button type="button" className={buttonClass('secondary', 'sm', 'max-lg:w-full')} data-testid="next-song" onClick={() => onNextSong(setlist.next as NonNullable<SetlistPosition['next']>)}>
            Próximo louvor: {setlist.next.title} →
          </button>
        )}
        {!compact && (
          <>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1" role="group" aria-label="Modo de avanço">
              <ModeButtons controls={controls} dispatch={dispatch} variant="ghost" />
            </div>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={openProjection}>
              {link.connection === 'connected' ? 'Reabrir janela de projeção' : 'Abrir janela de projeção'}
            </button>
            <button type="button" className={buttonClass('danger', 'sm')} onClick={onEnd}>
              Encerrar
            </button>
          </>
        )}
      </header>

      {/* No celular os avisos de rotina somem; só aparece o que pede atenção. */}
      {(!compact || link.connection !== 'none' || checkpoint === 'memory-only') && (
        <div className="flex flex-wrap gap-2">
          {(!compact || link.connection !== 'none') && (
            <p role="status" data-testid="projection-status" data-connection={link.connection} className={pillClass(link.connection === 'lost' ? 'danger' : link.connection === 'connected' && link.armed ? 'success' : link.connection === 'connected' ? 'accent' : 'neutral')}>
              {link.connection === 'lost' ? '⚠ ' : link.connection === 'connected' ? '● ' : '○ '}
              {projectionText}
            </p>
          )}
          {(!compact || checkpoint === 'memory-only') && (
            <p role="status" data-testid="checkpoint-status" data-state={checkpoint} className={pillClass(checkpoint === 'memory-only' ? 'danger' : 'neutral')}>
              {checkpoint === 'saved' && '✓ Guardado nesta sessão'}
              {checkpoint === 'saving' && 'Guardando…'}
              {checkpoint === 'memory-only' && '⚠ Não foi possível gravar: o ajuste está apenas em memória.'}
            </p>
          )}
        </div>
      )}

      {link.fontMissing && (
        <p role="alert" data-testid="projection-font-missing" className={noticeClass('danger')}>
          ⚠ A janela de projeção não conseguiu carregar o arquivo da fonte deste slide e está usando a fonte de reserva. Escolha Inter ou outra
          fonte no menu.
        </p>
      )}
      {popupBlocked && (
        <p role="alert" className={noticeClass('danger')}>
          O navegador bloqueou a nova janela. Permita pop-ups para este endereço e clique de novo.
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} role="alert" data-testid="session-warning" className={noticeClass('danger')}>
          ⚠ {warning}
        </p>
      ))}
      {view.notice === 'suspension-detected' && (
        <p role="alert" data-testid="suspension-notice" className={noticeClass('danger', 'text-foreground')}>
          O computador ou a aba ficou suspenso durante a apresentação. Ela foi pausada neste slide, com a faixa parada, sem pular os slides que
          venceram. Retome quando quiser ou navegue para onde a música está.
        </p>
      )}
      {wakeLock === 'released' && state.status === 'running' && (
        <p role="status" data-testid="wake-lock-lost" className={noticeClass('neutral', 'py-2 text-muted')}>
          O navegador não está mantendo a tela acordada. Deixe esta janela visível e desative a suspensão automática do computador durante o culto.
        </p>
      )}
      {message && (
        <p role="status" data-testid="operator-message" className={noticeClass('accent', 'py-2 text-foreground')}>
          {message}
        </p>
      )}

      {/* Em telas largas só esta área rola: cabeçalho, miniaturas e comandos ficam sempre à vista. */}
      <div className="grid gap-4 scrollbar-thin max-lg:my-auto lg:-m-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(16rem,22rem)] lg:items-start lg:overflow-y-auto lg:p-1">
        <section aria-labelledby="atual" className="flex flex-col gap-2">
          <h2 id="atual" className="text-xs font-bold uppercase tracking-wider text-muted">
            {state.cover ? 'Abertura' : `Slide atual · ${current.label || 'Sem rótulo'}`}
          </h2>
          <div className="relative">
            <div data-testid="current-slide">
              <SlideView text={current.text} style={current.style} fontId={current.fontId} cover={view.live.cover} transitionKey={`${current.occurrenceId}:${view.live.cover ? 'abertura' : 'letra'}`} className="w-full overflow-hidden rounded-2xl border-2 border-accent/70 shadow-pop" />
            </div>
            {/* Sobre o slide, como os controles do modo interativo: cinza claro em fundo escuro, legível em qualquer tema. */}
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-[rgba(209,213,219,0.35)] bg-[rgba(0,0,0,0.45)] text-[rgba(209,213,219,0.9)] transition-colors duration-150 hover:border-[rgba(209,213,219,0.9)] hover:text-[#D1D5DB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D1D5DB]"
              aria-label="Modo interativo"
              title="Modo interativo"
              data-testid="enter-interactive"
              onClick={() => setInteractive(true)}
            >
              <ExpandIcon />
            </button>
          </div>
          {!state.cover && <SlideChecks slide={current} />}
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
            {state.cover && <span data-testid="cover-status">{introTimed ? (controls.audio ? 'Abertura na tela: a letra entra sozinha quando a música chegar ao tempo da introdução.' : 'Abertura na tela: a letra entra sozinha no fim da introdução.') : 'Abertura na tela: avance para mostrar a letra.'}</span>}
            {state.awaitingManualAdvance && !state.cover && <span data-testid="awaiting-advance">Sem tempo neste slide: aguardando você avançar.</span>}
            {state.mode === 'manual' && state.status !== 'ready' && <span className="text-muted">Avanço manual.</span>}
            {state.status === 'ready' && <span className="text-muted">Pronta. O público vê preto até você iniciar.</span>}
            {state.status === 'paused' && <span className="font-semibold">Em pausa.</span>}
            {state.status === 'finished' && <span className="font-semibold">Fim da sequência.</span>}
          </div>
          {state.mode === 'manual' && state.manualTiming.active && (
            <p className="text-xs text-muted" data-testid="assisted-timing-progress">
              Ensaio assistido: {state.manualTiming.captured} de {state.manualTiming.total} passagens registradas. Avance os textos na ordem da música.
            </p>
          )}
          {state.mode === 'manual' && controls.audio?.policy !== 'linked' && state.currentIndex === slides.length - 1 && state.status === 'running' && !state.manualTiming.complete && state.manualTiming.captured === slides.length - 1 && (
            <section className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/5 p-3" data-testid="assisted-timing-save">
              <p className="text-sm">Último texto em exibição. Salve os tempos registrados para usar este louvor no automático.</p>
              <button type="button" className={buttonClass('primary', 'sm')} onClick={() => void saveAssistedTiming()}>
                Salvar padrão automático
              </button>
            </section>
          )}
          {state.manualTiming.complete && (
            <p role="status" className="text-sm text-success" data-testid="assisted-timing-saved">
              ✓ Padrão automático preparado com os tempos deste ensaio.
            </p>
          )}
          <AudioPanel controller={controller} view={view} dispatch={dispatch} choices={audioChoices} selectedBindingId={row.snapshot.audio?.bindingId ?? null} onChoose={onChooseAudio} />
        </section>

        {/* No celular o slide do centro já é o que o público vê; sobram só as notas privadas. */}
        {(!compact || row.snapshot.song.notes.trim() !== '') && (
          <section aria-label="Saída pública e notas" className="flex flex-col gap-3">
            {!compact && (
              <div className="flex flex-col gap-2">
                <h2 id="lado" className="text-xs font-bold uppercase tracking-wider text-muted">
                  O público vê agora
                </h2>
                <PublicPreview frame={output} rotation={view.rotation} />
                <p className="text-xs font-semibold text-muted" data-testid="public-summary">
                  {state.status === 'ready' ? 'Preto (aguardando iniciar)' : output.cover && output.visualMode === 'normal' ? 'Abertura' : OUTPUT_LABEL[output.visualMode]}
                  {state.frozenOutput && ' · congelada'}
                  {frozenDiffers && ' · diferente do slide atual'}
                </p>
              </div>
            )}
            {row.snapshot.song.notes.trim() !== '' && (
              <div className="flex flex-col gap-1">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Notas privadas</h2>
                <p className="whitespace-pre-line rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-sm" data-testid="private-notes">
                  {row.snapshot.song.notes}
                </p>
              </div>
            )}
            {!compact && (
              <div className="flex flex-col gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Próximo slide{upcoming ? ` · ${upcoming.label || 'Sem rótulo'}` : ''}</h2>
                {upcoming ? (
                  <div data-testid="next-slide">
                    <SlideView text={upcoming.text} style={upcoming.style} fontId={upcoming.fontId} className="w-full overflow-hidden rounded-xl border border-border" />
                  </div>
                ) : (
                  <p className="text-sm text-muted">Este é o último slide.</p>
                )}
              </div>
            )}
          </section>
        )}

        {/* Coluna privada: nada daqui é enviado à janela de projeção. */}
        {!compact && (
          <aside aria-label="Ajustes ao vivo" className="max-h-[70dvh] overflow-y-auto rounded-2xl border border-border bg-surface-raised p-3 shadow-card scrollbar-thin lg:sticky lg:top-0 lg:max-h-[calc(100dvh-21rem)]">
            <LiveMenu controls={controls} dispatch={dispatch} operatorItems={operatorItems} linkedTiming={linkedTiming} />
          </aside>
        )}
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/60" data-testid="operator-menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Ajustes ao vivo" className="flex h-full w-[min(24rem,100%)] flex-col gap-3 overflow-y-auto border-l border-border bg-surface-raised p-4 pb-safe shadow-pop scrollbar-thin" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold">Ajustes</h2>
              <button type="button" autoFocus className={buttonClass('secondary', 'sm', 'min-h-11 min-w-11 border-danger px-2 text-danger hover:border-danger hover:text-danger')} aria-label="Fechar" title="Fechar" onClick={() => setMenuOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <LiveMenu controls={controls} dispatch={dispatch} operatorItems={operatorItems} linkedTiming={linkedTiming} />
          </div>
        </div>
      )}

      <ol className="flex shrink-0 gap-2 overflow-x-auto p-1 pb-2 scrollbar-thin" aria-label="Slides da apresentação">
        {slides.map((slide, index) => (
          <li key={slide.occurrenceId} className="w-36 shrink-0">
            <button
              type="button"
              data-testid="thumbnail"
              data-occurrence-id={slide.occurrenceId}
              aria-current={index === state.currentIndex ? 'true' : undefined}
              aria-label={`Ir para o slide ${index + 1}: ${slide.label || 'sem rótulo'}`}
              onClick={() => dispatch({ type: 'goTo', occurrenceId: slide.occurrenceId })}
              className={cn(
                'flex w-full cursor-pointer flex-col gap-1 rounded-xl border-2 p-1 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                index === state.currentIndex ? 'border-accent bg-accent/10' : 'border-border hover:border-border-strong',
              )}
            >
              <SlideView text={slide.text} style={slide.style} fontId={slide.fontId} className="w-full overflow-hidden rounded-lg" />
              <span className="flex justify-between gap-1 px-0.5">
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
      <div className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-auto flex shrink-0 flex-col gap-2 border-t border-border bg-surface-raised/95 px-3 py-3 pb-safe backdrop-blur-md sm:-mx-4 sm:-mb-4 sm:px-4" data-testid="operator-controls">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Controle da apresentação">
          <button type="button" className={buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3')} onClick={() => dispatch({ type: 'previous' })}>
            ← Voltar
          </button>
          {state.status === 'ready' && (
            <button type="button" className={buttonClass('primary', 'lg', 'max-sm:flex-1 max-sm:px-3')} onClick={() => dispatch({ type: 'start' })}>
              ▶ Iniciar
            </button>
          )}
          {/* Sem duração atual no automático e sem faixa, não existe play/pause. */}
          {controls.capabilities.transport && (
            <button type="button" className={buttonClass('primary', 'lg', 'max-sm:flex-1 max-sm:px-3')} data-testid="transport" onClick={() => dispatch({ type: 'toggle' })}>
              {transportLabel}
            </button>
          )}
          <button type="button" className={cn(buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3'), voiceCue && 'lv-cue-blink')} data-testid="advance" data-auto={controls.capabilities.countdown} data-voice-cue={voiceCue} onClick={() => dispatch({ type: 'next' })}>
            {lyricsCue ? 'Letra' : 'Avançar'} {controls.capabilities.countdown ? <span className="lv-auto-spinner" data-testid="auto-spinner" aria-hidden="true" /> : '→'}
          </button>
          <span className="mx-2 h-8 w-px bg-border max-sm:hidden" aria-hidden="true" />
          <button type="button" className={cn(buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3'), state.visualMode === 'black' && pressedClass)} aria-pressed={state.visualMode === 'black'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: state.visualMode === 'black' ? 'normal' : 'black' })}>
            Tela preta
          </button>
          <button type="button" className={cn(buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3'), state.visualMode === 'lyricsHidden' && pressedClass)} aria-pressed={state.visualMode === 'lyricsHidden'} onClick={() => dispatch({ type: 'setVisualMode', visualMode: state.visualMode === 'lyricsHidden' ? 'normal' : 'lyricsHidden' })}>
            Ocultar letra
          </button>
          <button type="button" className={cn(buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3'), state.frozenOutput && pressedClass)} aria-pressed={state.frozenOutput} onClick={() => dispatch({ type: 'setFrozen', frozen: !state.frozenOutput })}>
            {state.frozenOutput ? 'Liberar saída' : 'Congelar'}
          </button>
          {state.status !== 'ready' && (
            <button type="button" className={buttonClass('secondary', 'lg', 'max-sm:flex-1 max-sm:px-3')} onClick={() => dispatch({ type: 'stop' })}>
              ■ Parar
            </button>
          )}
        </div>
        <p className="text-xs text-muted max-md:hidden">
          Atalhos: → ou Page Down avança · ← ou Page Up volta · Espaço inicia, pausa ou retoma · B tela preta · L oculta a letra · C congela · Home vai ao
          primeiro slide.
        </p>
      </div>
    </main>
  );
}

/** O que a janela pública está mostrando, com a rotação da saída. */
function PublicPreview({ frame, rotation }: { frame: OutputFrame; rotation: 0 | 90 }) {
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-border" data-testid="public-preview" data-occurrence-id={frame.occurrenceId}>
      <SlideView fit="fill" text={frame.slide.text} style={frame.slide.style} fontId={frame.slide.fontId} visualMode={frame.visualMode} rotation={rotation} cover={frame.cover} transitionKey={`${frame.occurrenceId}:${frame.cover ? 'abertura' : 'letra'}`} />
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
