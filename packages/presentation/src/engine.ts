import {
  cueIndexAt,
  deriveCues,
  linkIssues,
  type AudioCue,
  type AudioKind,
  type BundledFontId,
  type FontWeight,
  type PresentationMode,
  type TextAlign,
  type ThemePresetId,
  type Uuid,
  type VerticalAlign,
} from '@louvorvisual/domain';
import { AudioPlayBlockedError, type AudioTransport, type AudioTransportEvent } from './audio';
import type { EngineClock, TimerHandle } from './clock';
import {
  applyDuration,
  applyDurations,
  applyText,
  applyVisual,
  canUndoOverrides,
  emptyOverrides,
  hasVisualOverrides,
  OVERRIDES_UNDO_LIMIT,
  resetVisual,
  resolveSlide,
  restoreAppearance,
  steppedFontSize,
  undoOverrides,
  visualPatchIssues,
  type AdjustScope,
  type OverridesState,
  type ResolvedSlide,
  type SessionOverrides,
  type VisualKey,
  type VisualPatch,
} from './overrides';
import { isRotation, nextRotation, type Rotation, type VisualMode } from './renderer';
import type { SessionSnapshot } from './snapshot';

export type SessionStatus = 'ready' | 'running' | 'paused' | 'finished' | 'error';

/** Estado da sessão (planejamento/05). */
export type SessionState = {
  sessionId: Uuid;
  snapshotId: Uuid;
  status: SessionStatus;
  mode: PresentationMode;
  currentOccurrenceId: Uuid;
  currentIndex: number;
  elapsedInSlideMs: number;
  awaitingManualAdvance: boolean;
  /** Abertura em exibição: iniciada, mas ainda antes do primeiro slide da letra. */
  cover: boolean;
  overridesRevision: number;
  clockSource: 'monotonic' | 'audio';
  audioPolicy: 'none' | 'independent' | 'linked';
  visualMode: VisualMode;
  frozenOutput: boolean;
  sequenceNumber: number;
  /** Ensaio assistido no manual: tempos já capturados para o padrão automático. */
  manualTiming: { active: boolean; complete: boolean; captured: number; total: number };
};

/** Um quadro da saída: o que desenhar, sem nada sobre tempo. */
export type OutputFrame = {
  occurrenceId: Uuid;
  index: number;
  visualMode: VisualMode;
  slide: ResolvedSlide;
  overridesRevision: number;
  /** Abertura: a saída desenha o slide de abertura, com o título, no lugar da letra. Ausente fora dela. */
  cover?: { title: string; artist: string | null };
};

/** Elementos que só existem quando há o que controlar (planejamento/20). */
export type Capabilities = {
  /** Indicador de tempo: só com duração na ocorrência atual. */
  timerIndicator: boolean;
  /** Contagem regressiva: duração configurada e avanço automático em execução. */
  countdown: boolean;
  /** Play/pause: faixa pronta ou duração atual no modo automático. */
  transport: boolean;
};

export type SessionAudioPolicy = 'none' | 'independent' | 'linked';

/** Faixa da sessão como os controles a mostram. A posição não vem aqui: é lida do player. */
export type AudioControls = {
  kind: AudioKind;
  filename: string;
  policy: Exclude<SessionAudioPolicy, 'none'>;
  playing: boolean;
  volume: number;
  durationMs: number;
  /** Faixa independente pausa junto quando um slide temporizado é pausado. */
  followsPause: boolean;
  /** Há um reposicionamento aguardando a confirmação do player. */
  seeking: boolean;
};

/** Resumo para desenhar controles; é o que a janela pública recebe quando os habilita. */
export type ControlsState = {
  status: SessionStatus;
  mode: PresentationMode;
  index: number;
  total: number;
  occurrenceId: Uuid;
  label: string;
  durationMs: number | null;
  awaitingManualAdvance: boolean;
  /** A sessão está na abertura, antes do primeiro slide da letra. */
  cover?: boolean;
  capabilities: Capabilities;
  visualMode: VisualMode;
  frozen: boolean;
  rotation: Rotation;
  appearance: {
    themePresetId: ThemePresetId | null;
    fontId: BundledFontId;
    fontChosen: boolean;
    fontSizePx: number;
    fontWeight: FontWeight;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    lineHeight: number;
  };
  canUndo: boolean;
  hasVisualOverrides: boolean;
  overridesRevision: number;
  /** O que o play/pause compacto mostra: a sessão, ou a faixa quando o transporte é separado. */
  playing: boolean;
  audio: AudioControls | null;
};

export type EngineNotice =
  | 'suspension-detected'
  /** O navegador recusou tocar sem um gesto; a sessão espera o operador. */
  | 'autoplay-blocked'
  /** O reposicionamento falhou: em pausa, no último estado confirmado. */
  | 'seek-failed'
  /** A faixa vinculada parou sem pausa pedida; slide e contador seguem a posição real. */
  | 'audio-stalled'
  /** A gravação acabou antes do fim planejado dos slides. */
  | 'audio-ended-early'
  | 'audio-failed'
  | null;

export type EngineView = {
  state: SessionState;
  controls: ControlsState;
  /** Sequência com texto, tempo e aparência em vigor. */
  slides: ResolvedSlide[];
  current: ResolvedSlide;
  next: ResolvedSlide | null;
  /** Quadro do slide atual, como sairia sem congelamento. */
  live: OutputFrame;
  /** O que o público está vendo agora. */
  output: OutputFrame;
  rotation: Rotation;
  remainingMs: number | null;
  notice: EngineNotice;
};

export type OperatorCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'first' }
  | { type: 'goTo'; occurrenceId: Uuid }
  | { type: 'setMode'; mode: PresentationMode }
  /** Fecha o ensaio manual no último slide e prepara seus tempos para salvar. */
  | { type: 'completeManualTiming' }
  | { type: 'restartOccurrence' }
  | { type: 'stop' }
  | { type: 'setVisualMode'; visualMode: VisualMode }
  | { type: 'setFrozen'; frozen: boolean }
  | { type: 'adjust'; scope: AdjustScope; patch: VisualPatch }
  | { type: 'resetAdjustment'; scope: AdjustScope; keys: VisualKey[] }
  | { type: 'stepFontSize'; direction: 1 | -1; scope: AdjustScope }
  | { type: 'setDuration'; occurrenceId: Uuid; durationMs: number | null }
  | { type: 'applyText'; occurrenceId: Uuid; text: string }
  | { type: 'setRotation'; rotation: Rotation }
  | { type: 'rotate' }
  | { type: 'undo' }
  | { type: 'restoreAppearance' }
  // ── faixa da sessão ──
  | { type: 'audioPlay' }
  | { type: 'audioPause' }
  | { type: 'audioToggle' }
  | { type: 'audioSeek'; positionMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setAudioFollowsPause'; value: boolean }
  /** Novos tempos com a faixa vinculada: só em pausa, com os intervalos revalidados. */
  | { type: 'applyLinkedTiming'; durations: Record<Uuid, number> }
  /** Passa a faixa a independente e o avanço a manual, sem mexer na posição. */
  | { type: 'unlinkAudio' }
  /** Segue sem a faixa (por exemplo, depois de uma falha). */
  | { type: 'dropAudio' };

export type CommandFailure =
  | 'invalid-state'
  | 'unknown-occurrence'
  | 'invalid-value'
  | 'at-limit'
  | 'nothing-to-undo'
  | 'no-transport'
  | 'no-audio'
  /** Com a faixa vinculada, o transporte é o da sessão e o tempo passa por revisão. */
  | 'audio-linked'
  | 'requires-pause'
  | 'invalid-timing';
export type CommandResult = { ok: true } | { ok: false; reason: CommandFailure };

/** O que é gravado para recuperar a sessão; nunca uma âncora do relógio monotônico. */
export type SessionCheckpoint = {
  sessionId: Uuid;
  snapshotId: Uuid;
  status: SessionStatus;
  mode: PresentationMode;
  currentOccurrenceId: Uuid;
  elapsedInSlideMs: number;
  visualMode: VisualMode;
  frozenFrame: OutputFrame | null;
  rotation: Rotation;
  overrides: SessionOverrides;
  undo: SessionOverrides[];
  /** Ausente em checkpoints anteriores à abertura. */
  cover?: boolean;
  /** Ausente em checkpoints anteriores ao áudio e em sessões sem faixa. */
  audio?: { policy: SessionAudioPolicy; positionMs: number; volume: number; followsPause: boolean; cues: AudioCue[] } | null;
};

export type EngineOptions = {
  snapshot: SessionSnapshot;
  clock: EngineClock;
  sessionId: Uuid;
  mode?: PresentationMode;
  rotation?: Rotation;
  /** Recupera uma sessão interrompida: sempre em pausa (ou pronta, se nem tinha começado). */
  checkpoint?: SessionCheckpoint;
  /** Player único da faixa do snapshot. Sem ele, a sessão segue sem áudio. */
  transport?: AudioTransport | null;
  /** Iniciar mostra primeiro a abertura; a letra só aparece quando o operador avança. */
  cover?: boolean;
  /** Ajustes de aparência para o louvor inteiro já aplicados ao abrir (preferências do operador). */
  appearance?: VisualPatch;
};

/**
 * Atraso de callback acima disto é tratado como suspensão: o motor retoma em
 * pausa em vez de projetar uma sequência acelerada de slides vencidos.
 */
export const SUSPENSION_THRESHOLD_MS = 5000;

/** Com a faixa como relógio, o despertador nunca é rearmado mais rápido que isto (faixa travada perto de uma troca). */
const AUDIO_WAKE_MIN_MS = 40;

const OK: CommandResult = { ok: true };
const fail = (reason: CommandFailure): CommandResult => ({ ok: false, reason });

/**
 * Motor de apresentação: uma instância por sessão, no dispositivo do operador.
 * Não conhece React, DOM nem armazenamento; recebe o relógio e publica estado.
 */
export class PresentationEngine {
  readonly snapshot: SessionSnapshot;
  readonly sessionId: Uuid;
  private readonly clock: EngineClock;
  private readonly listeners = new Set<() => void>();

  private status: SessionStatus = 'ready';
  private mode: PresentationMode;
  private index = 0;
  /** Tempo já consumido do slide atual antes da âncora. */
  private accumulatedMs = 0;
  /** Instante monotônico em que o intervalo atual voltou a correr; `null` desarmado. */
  private anchor: number | null = null;
  private timer: TimerHandle | null = null;
  private visualMode: VisualMode = 'normal';
  private frozenFrame: OutputFrame | null = null;
  private rotation: Rotation;
  private overrides: OverridesState = emptyOverrides();
  private sequenceNumber = 0;
  private notice: EngineNotice = null;
  private view: EngineView | null = null;
  private disposed = false;
  /** Cronômetro do ensaio assistido. Só registra avanços sequenciais no manual. */
  private manualTiming = new Map<Uuid, number>();
  private manualTimingAnchor: number | null = null;
  private manualTimingComplete = false;
  private readonly withCover: boolean;
  /** Abertura em exibição: nenhum relógio de slide corre até o operador avançar. */
  private cover = false;

  private readonly transport: AudioTransport | null;
  private audioPolicy: SessionAudioPolicy = 'none';
  /** Intervalos da faixa vinculada, na ordem da sequência. */
  private cues: AudioCue[] = [];
  private volume = 1;
  private followsPause = true;
  /** A faixa independente foi pausada pela pausa da sessão e volta com ela. */
  private audioPausedBySession = false;
  /** Reposicionamento em andamento; só o mais recente vale. */
  private pendingSeek: { generation: number; targetIndex: number | null } | null = null;
  private seekGeneration = 0;
  private playGeneration = 0;
  private unsubscribeTransport: (() => void) | null = null;
  /** Um comando está em execução: pausas e retomadas da faixa vêm dele e são publicadas uma vez, no fim. */
  private inCommand = false;

  constructor(options: EngineOptions) {
    if (options.snapshot.occurrences.length === 0) throw new RangeError('A sessão precisa de pelo menos um slide.');
    this.snapshot = options.snapshot;
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.mode = options.mode ?? options.snapshot.arrangement.defaultMode;
    this.rotation = options.rotation ?? 0;
    this.withCover = options.cover ?? false;
    if (options.appearance && Object.keys(options.appearance).length > 0 && visualPatchIssues(options.appearance).length === 0) {
      this.overrides = { current: { revision: 0, song: { ...options.appearance }, occurrences: {} }, undo: [] };
    }
    const audio = options.snapshot.audio;
    this.transport = audio ? (options.transport ?? null) : null;
    if (audio && this.transport) {
      this.audioPolicy = audio.policy;
      this.cues = audio.cues;
      this.volume = audio.volume;
      this.transport.setVolume(this.volume);
      this.unsubscribeTransport = this.transport.subscribe((event) => this.onTransport(event));
    }
    if (options.checkpoint) this.restore(options.checkpoint);
    else if (this.transport) void this.transport.seek(this.initialAudioPosition()).catch(() => undefined);
  }

  private restore(checkpoint: SessionCheckpoint): void {
    if (checkpoint.snapshotId !== this.snapshot.id) return;
    const index = this.snapshot.occurrences.findIndex((occurrence) => occurrence.id === checkpoint.currentOccurrenceId);
    this.index = Math.max(0, index);
    this.mode = checkpoint.mode;
    this.visualMode = checkpoint.visualMode;
    this.frozenFrame = checkpoint.frozenFrame;
    this.rotation = isRotation(checkpoint.rotation) ? checkpoint.rotation : 0;
    this.overrides = { current: checkpoint.overrides, undo: checkpoint.undo.slice(-OVERRIDES_UNDO_LIMIT) };
    // Recuperação nunca volta tocando: quem estava em execução retorna em pausa.
    this.status = checkpoint.status === 'running' ? 'paused' : checkpoint.status === 'error' ? 'paused' : checkpoint.status;
    this.accumulatedMs = index >= 0 && this.status === 'paused' ? Math.max(0, checkpoint.elapsedInSlideMs) : 0;
    this.cover = checkpoint.cover === true && this.status === 'paused';
    const audio = checkpoint.audio;
    if (!this.transport || !audio) return;
    // A faixa volta parada, na posição guardada; quem retoma é o operador.
    this.audioPolicy = audio.policy;
    this.cues = audio.cues;
    this.volume = audio.volume;
    this.followsPause = audio.followsPause;
    this.transport.setVolume(this.volume);
    if (audio.policy === 'none') return;
    this.audioPausedBySession = audio.policy === 'independent' && this.status === 'paused';
    void this.transport.seek(Math.max(0, audio.positionMs)).catch(() => undefined);
  }

  // ── faixa ────────────────────────────────────────────────────────────────

  private get audioActive(): boolean {
    return this.transport !== null && this.audioPolicy !== 'none';
  }

  private get linked(): boolean {
    return this.transport !== null && this.audioPolicy === 'linked';
  }

  /** No automático vinculado, o relógio é a posição da faixa; não há outro cronômetro. */
  private get audioClock(): boolean {
    return this.linked && this.mode === 'automatic';
  }

  private cueAt(index: number): AudioCue {
    return this.cues[index] as AudioCue;
  }

  private initialAudioPosition(): number {
    return this.linked ? this.cueAt(this.index).startMs : (this.snapshot.audio?.offsetMs ?? 0);
  }

  /** Posição efetiva do player; `null` sem faixa. Leitura para a interface, não é estado publicado. */
  audioPositionMs(): number | null {
    return this.audioActive ? (this.transport as AudioTransport).positionMs() : null;
  }

  private playAudio(): void {
    const transport = this.transport;
    if (!transport) return;
    const generation = ++this.playGeneration;
    transport.play().then(
      () => {
        if (this.disposed || generation !== this.playGeneration) return;
        if (this.notice === 'autoplay-blocked') {
          this.notice = null;
          this.changed();
        }
      },
      (error: unknown) => {
        if (this.disposed || generation !== this.playGeneration) return;
        this.notice = error instanceof AudioPlayBlockedError ? 'autoplay-blocked' : 'audio-failed';
        // Sem a faixa vinculada tocando, a sessão não finge que está andando.
        if (this.linked && this.status === 'running') {
          this.status = 'paused';
          this.disarm();
        }
        this.changed();
      },
    );
  }

  /**
   * Pede o reposicionamento e só publica o destino quando o player confirma.
   * Um pedido novo torna os anteriores sem efeito, mesmo que respondam depois.
   */
  private requestSeek(positionMs: number, targetIndex: number | null): void {
    const transport = this.transport as AudioTransport;
    const generation = ++this.seekGeneration;
    this.pendingSeek = { generation, targetIndex };
    this.disarm();
    transport.seek(positionMs).then(
      () => {
        if (this.disposed || generation !== this.seekGeneration) return;
        this.pendingSeek = null;
        if (targetIndex !== null) this.index = targetIndex;
        if (this.notice === 'seek-failed') this.notice = null;
        // Em execução continua tocando do destino; em pausa fica parado no início dele.
        if (this.linked && this.status === 'running' && !transport.isPlaying()) this.playAudio();
        this.arm();
        this.changed();
      },
      () => {
        if (this.disposed || generation !== this.seekGeneration) return;
        this.pendingSeek = null;
        if (this.linked) {
          transport.pause();
          if (this.status === 'running') this.status = 'paused';
        }
        this.notice = 'seek-failed';
        this.changed();
      },
    );
  }

  /** Seleciona a ocorrência cujo intervalo contém a posição da faixa. */
  private followAudio(): void {
    // Na abertura a faixa toca, mas a letra só passa a segui-la quando o operador avança.
    if (this.disposed || this.cover || !this.audioClock || this.status !== 'running' || this.pendingSeek !== null) return;
    const transport = this.transport as AudioTransport;
    const at = cueIndexAt(this.cues, transport.positionMs());
    if (at >= this.cues.length) {
      // Fim planejado do arranjo: mantém o último slide e para a faixa aqui.
      this.disarm();
      this.status = 'finished';
      this.index = this.cues.length - 1;
      transport.pause();
      this.changed();
      return;
    }
    const moved = at !== this.index;
    this.index = at;
    this.arm();
    if (moved) this.changed();
  }

  private onTransport(event: AudioTransportEvent): void {
    if (this.disposed || !this.audioActive) return;
    if (this.inCommand && (event.type === 'paused' || event.type === 'playing')) return;
    switch (event.type) {
      case 'time':
        this.followAudio();
        return;
      case 'playing':
        if (this.notice === 'audio-stalled' || this.notice === 'autoplay-blocked') this.notice = null;
        this.arm();
        this.changed();
        return;
      case 'paused':
        // Faixa vinculada pausada por fora (tecla de mídia, sistema): os slides param com ela.
        if (this.linked && this.status === 'running' && this.pendingSeek === null) {
          this.status = 'paused';
          this.disarm();
        }
        this.changed();
        return;
      case 'waiting':
        if (this.linked && this.status === 'running') this.notice = 'audio-stalled';
        this.changed();
        return;
      case 'ended':
        if (this.audioClock && this.status === 'running') {
          this.followAudio();
          if (this.status === 'running') {
            // A gravação acabou antes do fim planejado dos slides.
            this.status = 'paused';
            this.disarm();
            this.notice = 'audio-ended-early';
            this.changed();
          }
          return;
        }
        this.changed();
        return;
      case 'error':
        this.notice = 'audio-failed';
        if (this.linked && this.status === 'running') {
          this.status = 'paused';
          this.disarm();
        }
        this.changed();
        return;
    }
  }

  /**
   * O dispositivo ou a aba ficou sem executar por tempo demais. Quem hospeda o
   * motor avisa; a sessão volta em pausa, com a faixa parada, sem pular slides.
   */
  notifySuspension(): void {
    if (this.disposed || this.status !== 'running') return;
    // Sem relógio de slide nem faixa tocando, não há o que proteger: o manual segue como estava.
    const audioPlaying = this.audioActive && (this.transport as AudioTransport).isPlaying();
    if (!audioPlaying && !(this.mode === 'automatic' && this.currentDuration() !== null)) return;
    this.disarm();
    this.status = 'paused';
    this.accumulatedMs = 0;
    this.anchor = null;
    if (this.transport?.isPlaying() && this.audioActive) {
      this.transport.pause();
      this.audioPausedBySession = this.audioPolicy === 'independent';
    }
    this.notice = 'suspension-detected';
    this.changed();
  }

  // ── leitura ──────────────────────────────────────────────────────────────

  private slideAt(index: number): ResolvedSlide {
    const occurrence = this.snapshot.occurrences[index];
    if (!occurrence) throw new RangeError('Índice fora da sequência.');
    return resolveSlide(this.snapshot, this.overrides.current, occurrence);
  }

  private currentDuration(): number | null {
    return this.slideAt(this.index).durationMs;
  }

  private elapsed(): number {
    if (this.cover) return 0;
    if (this.audioClock) {
      const cue = this.cueAt(this.index);
      return Math.min(cue.endMs - cue.startMs, Math.max(0, (this.transport as AudioTransport).positionMs() - cue.startMs));
    }
    return this.accumulatedMs + (this.anchor === null ? 0 : this.clock.now() - this.anchor);
  }

  private manualTimingState() {
    return { active: this.mode === 'manual' && this.status === 'running' && !this.manualTimingComplete, complete: this.manualTimingComplete, captured: this.manualTiming.size, total: this.snapshot.occurrences.length };
  }

  private beginManualTiming(): void {
    if (this.mode === 'manual' && this.status === 'running' && !this.cover && !this.manualTimingComplete && this.manualTimingAnchor === null) this.manualTimingAnchor = this.clock.now();
  }

  private pauseManualTiming(): void {
    this.manualTimingAnchor = null;
  }

  /** Guarda o tempo do slide que acabou de ser avançado, nunca de saltos. */
  private captureManualTiming(nextIndex: number): void {
    if (this.mode !== 'manual' || this.status !== 'running' || this.manualTimingComplete || nextIndex !== this.index + 1 || this.manualTimingAnchor === null) return;
    const occurrence = this.snapshot.occurrences[this.index] as { id: Uuid };
    this.manualTiming.set(occurrence.id, Math.max(500, Math.round(this.clock.now() - this.manualTimingAnchor)));
    this.manualTimingAnchor = this.clock.now();
  }

  private completeManualTiming(): CommandResult {
    if (this.mode !== 'manual' || this.status !== 'running' || this.index !== this.snapshot.occurrences.length - 1 || this.manualTimingAnchor === null) return fail('invalid-state');
    const occurrence = this.snapshot.occurrences[this.index] as { id: Uuid };
    this.manualTiming.set(occurrence.id, Math.max(500, Math.round(this.clock.now() - this.manualTimingAnchor)));
    if (this.manualTiming.size !== this.snapshot.occurrences.length) return fail('invalid-state');
    const next = applyDurations(this.overrides, Object.fromEntries(this.manualTiming) as Record<Uuid, number>);
    if (next) this.overrides = next;
    this.manualTimingComplete = true;
    this.manualTimingAnchor = null;
    return OK;
  }

  getState(): SessionState {
    const current = this.slideAt(this.index);
    const timed = this.mode === 'automatic' && current.durationMs !== null;
    return {
      sessionId: this.sessionId,
      snapshotId: this.snapshot.id,
      status: this.status,
      mode: this.mode,
      currentOccurrenceId: current.occurrenceId,
      currentIndex: this.index,
      elapsedInSlideMs: timed ? Math.min(this.elapsed(), current.durationMs ?? 0) : 0,
      awaitingManualAdvance: this.cover || (this.mode === 'automatic' && current.durationMs === null && this.status !== 'finished'),
      cover: this.cover,
      overridesRevision: this.overrides.current.revision,
      clockSource: this.audioClock ? 'audio' : 'monotonic',
      audioPolicy: this.transport ? this.audioPolicy : 'none',
      visualMode: this.visualMode,
      frozenOutput: this.frozenFrame !== null,
      sequenceNumber: this.sequenceNumber,
      manualTiming: this.manualTimingState(),
    };
  }

  /** Tempo que falta no slide atual; `null` sem duração ou fora do automático. */
  remainingMs(): number | null {
    const duration = this.currentDuration();
    if (duration === null || this.mode !== 'automatic' || this.cover) return null;
    if (this.audioClock) return Math.max(0, this.cueAt(this.index).endMs - (this.transport as AudioTransport).positionMs());
    return Math.max(0, duration - this.elapsed());
  }

  private liveFrame(): OutputFrame {
    const slide = this.slideAt(this.index);
    return {
      occurrenceId: slide.occurrenceId,
      index: this.index,
      // Antes de iniciar, o público não vê o slide escolhido na preparação.
      visualMode: this.status === 'ready' ? 'black' : this.visualMode,
      slide,
      overridesRevision: this.overrides.current.revision,
      ...(this.cover ? { cover: { title: this.snapshot.song.title, artist: this.snapshot.song.artist } } : {}),
    };
  }

  /** Visão derivada; estável entre alterações para uso com `subscribe`. */
  getView(): EngineView {
    if (this.view) return this.view;
    const state = this.getState();
    const slides = this.snapshot.occurrences.map((_, index) => this.slideAt(index));
    const current = slides[this.index] as ResolvedSlide;
    const live = this.liveFrame();
    const hasDuration = current.durationMs !== null;
    const timed = hasDuration && this.mode === 'automatic';
    const snapshotAudio = this.snapshot.audio;
    const audio: AudioControls | null =
      this.audioActive && snapshotAudio
        ? {
            kind: snapshotAudio.kind,
            filename: snapshotAudio.filename,
            policy: this.audioPolicy as AudioControls['policy'],
            playing: (this.transport as AudioTransport).isPlaying(),
            volume: this.volume,
            durationMs: snapshotAudio.durationMs,
            followsPause: this.followsPause,
            seeking: this.pendingSeek !== null,
          }
        : null;
    const controls: ControlsState = {
      status: state.status,
      mode: state.mode,
      index: this.index,
      total: slides.length,
      occurrenceId: current.occurrenceId,
      label: current.label,
      durationMs: current.durationMs,
      awaitingManualAdvance: state.awaitingManualAdvance,
      ...(this.withCover ? { cover: this.cover } : {}),
      capabilities: {
        timerIndicator: hasDuration,
        countdown: hasDuration && this.mode === 'automatic' && this.status === 'running' && !this.cover,
        // Faixa pronta mantém o play/pause mesmo em slide sem temporizador.
        transport: (timed || audio !== null) && this.status !== 'ready',
      },
      visualMode: this.visualMode,
      frozen: this.frozenFrame !== null,
      rotation: this.rotation,
      appearance: {
        themePresetId: current.themePresetId,
        fontId: current.fontId,
        fontChosen: current.fontChosen,
        fontSizePx: current.style.fontSizePx,
        fontWeight: current.style.fontWeight,
        textAlign: current.style.textAlign,
        verticalAlign: current.style.verticalAlign,
        lineHeight: current.style.lineHeight,
      },
      canUndo: canUndoOverrides(this.overrides),
      hasVisualOverrides: hasVisualOverrides(this.overrides.current),
      overridesRevision: this.overrides.current.revision,
      playing: this.separateTransport() ? (audio?.playing ?? false) : this.status === 'running',
      audio,
    };
    this.view = {
      state,
      controls,
      slides,
      current,
      next: slides[this.index + 1] ?? null,
      live,
      output: this.frozenFrame ?? live,
      rotation: this.rotation,
      remainingMs: this.remainingMs(),
      notice: this.notice,
    };
    return this.view;
  }

  getOverrides(): SessionOverrides {
    return this.overrides.current;
  }

  checkpoint(): SessionCheckpoint {
    const state = this.getState();
    return {
      sessionId: this.sessionId,
      snapshotId: this.snapshot.id,
      status: state.status,
      mode: state.mode,
      currentOccurrenceId: state.currentOccurrenceId,
      elapsedInSlideMs: state.elapsedInSlideMs,
      visualMode: this.visualMode,
      frozenFrame: this.frozenFrame,
      rotation: this.rotation,
      overrides: this.overrides.current,
      undo: this.overrides.undo,
      ...(this.cover ? { cover: true } : {}),
      audio: this.transport
        ? { policy: this.audioPolicy, positionMs: Math.round(this.transport.positionMs()), volume: this.volume, followsPause: this.followsPause, cues: this.cues }
        : null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.unsubscribeTransport?.();
    this.listeners.clear();
  }

  // ── relógio ──────────────────────────────────────────────────────────────

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Para de contar guardando o que já foi consumido. */
  private hold(): void {
    this.accumulatedMs = this.elapsed();
    this.anchor = null;
    this.disarm();
  }

  /** Arma o despertador do slide atual, se há o que esperar. Sem duração, só aguarda. */
  private arm(): void {
    this.disarm();
    if (this.cover) return;
    if (this.audioClock) {
      // O despertador só acorda o motor perto do fim do intervalo; quem decide é a posição da faixa.
      if (this.status !== 'running' || this.pendingSeek !== null) return;
      const remaining = this.cueAt(this.index).endMs - (this.transport as AudioTransport).positionMs();
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.followAudio();
      }, Math.max(AUDIO_WAKE_MIN_MS, remaining));
      return;
    }
    const duration = this.currentDuration();
    if (this.status !== 'running' || this.mode !== 'automatic' || duration === null) {
      if (this.anchor !== null) this.hold();
      this.beginManualTiming();
      return;
    }
    if (this.anchor === null) this.anchor = this.clock.now();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.reconcile();
    }, Math.max(0, duration - this.elapsed()));
  }

  /** Zera o intervalo do slide atual e volta a contar conforme modo e estado. */
  private restartInterval(): void {
    this.accumulatedMs = 0;
    this.anchor = null;
    this.arm();
  }

  /**
   * Reconcilia a posição com o tempo efetivamente decorrido. Chamado pelo
   * despertador e por quem hospeda o motor (visibilidade, verificação periódica).
   */
  reconcile(): void {
    if (this.audioClock) {
      this.followAudio();
      return;
    }
    if (this.disposed || this.status !== 'running' || this.mode !== 'automatic' || this.anchor === null) return;
    let duration = this.currentDuration();
    if (duration === null) return;
    let overshoot = this.elapsed() - duration;
    if (overshoot < 0) {
      this.arm();
      return;
    }
    if (overshoot > SUSPENSION_THRESHOLD_MS) {
      // Suspensão: fica no slide atual, em pausa, com o intervalo inteiro pela frente.
      this.disarm();
      this.status = 'paused';
      this.accumulatedMs = 0;
      this.anchor = null;
      this.notice = 'suspension-detected';
      this.changed();
      return;
    }
    // Callback atrasado: consome os intervalos vencidos, sem somar uma duração
    // inteira a partir de cada despertar e sem atravessar um slide sem tempo.
    for (;;) {
      if (this.index >= this.snapshot.occurrences.length - 1) {
        this.disarm();
        this.status = 'finished';
        this.accumulatedMs = duration;
        this.anchor = null;
        break;
      }
      this.index += 1;
      duration = this.currentDuration();
      if (duration === null) {
        this.accumulatedMs = 0;
        this.anchor = null;
        this.disarm();
        break;
      }
      if (overshoot < duration) {
        this.accumulatedMs = overshoot;
        this.anchor = this.clock.now();
        this.arm();
        break;
      }
      overshoot -= duration;
    }
    this.changed();
  }

  private changed(): void {
    this.sequenceNumber += 1;
    this.view = null;
    for (const listener of [...this.listeners]) listener();
  }

  // ── comandos ─────────────────────────────────────────────────────────────

  /** Sai da abertura para o slide escolhido; é aqui que o tempo do slide começa a contar. */
  private leaveCover(): CommandResult {
    this.cover = false;
    if (this.linked) {
      // A faixa não é reposicionada: no automático a letra entra onde a música está.
      this.followAudio();
      this.arm();
      return OK;
    }
    this.restartInterval();
    this.beginManualTiming();
    return OK;
  }

  private select(index: number): CommandResult {
    if (index < 0 || index >= this.snapshot.occurrences.length) return fail('at-limit');
    this.cover = false;
    if (this.linked) {
      // Faixa vinculada: o destino só aparece depois de o player confirmar a posição.
      if (this.status === 'finished') this.status = 'running';
      if (this.notice !== 'seek-failed') this.notice = null;
      this.requestSeek(this.cueAt(index).startMs, index);
      return OK;
    }
    // Um retorno ou salto deixa de representar uma passagem contínua da música.
    // Recomeçamos a coleta para que o padrão salvo nunca misture trechos de ensaios diferentes.
    if (this.mode === 'manual' && !this.manualTimingComplete && index !== this.index + 1) {
      this.manualTiming.clear();
      this.manualTimingAnchor = this.status === 'running' ? this.clock.now() : null;
    }
    this.index = index;
    // Sair do fim por navegação volta a executar; pausa e pronto são mantidos.
    if (this.status === 'finished') this.status = 'running';
    this.notice = null;
    this.restartInterval();
    return OK;
  }

  private adjust(apply: (state: OverridesState) => OverridesState | null): CommandResult {
    const durationBefore = this.currentDuration();
    const next = apply(this.overrides);
    if (!next) return fail('invalid-value');
    // Com a faixa vinculada, tempos só mudam pela revisão em pausa, junto com os intervalos.
    if (this.linked && this.durationsDiffer(next.current)) return fail('audio-linked');
    this.overrides = next;
    // Só a duração do slide atual mexe no relógio; aparência e texto, nunca.
    if (this.currentDuration() !== durationBefore) this.restartInterval();
    return OK;
  }

  private durationsDiffer(next: SessionOverrides): boolean {
    return this.snapshot.occurrences.some(
      (occurrence) => resolveSlide(this.snapshot, next, occurrence).durationMs !== resolveSlide(this.snapshot, this.overrides.current, occurrence).durationMs,
    );
  }

  /**
   * Faixa independente e nenhum relógio de slide em jogo (manual, ou slide sem
   * tempo): não há apresentação a pausar, então o play/pause compacto age na faixa.
   */
  private separateTransport(): boolean {
    return this.audioActive && !this.linked && !(this.mode === 'automatic' && this.currentDuration() !== null);
  }

  private toggleAudio(): CommandResult {
    const transport = this.transport as AudioTransport;
    if (transport.isPlaying()) {
      transport.pause();
      this.audioPausedBySession = false;
    } else {
      this.playAudio();
    }
    return OK;
  }

  /** Único ponto de entrada de comandos, do painel ou encaminhados pela saída. */
  execute(command: OperatorCommand): CommandResult {
    if (this.disposed) return fail('invalid-state');
    this.inCommand = true;
    let result: CommandResult;
    try {
      result = this.run(command);
    } finally {
      this.inCommand = false;
    }
    if (result.ok) this.changed();
    return result;
  }

  private run(command: OperatorCommand): CommandResult {
    const currentId = (this.snapshot.occurrences[this.index] as { id: Uuid }).id;
    switch (command.type) {
      case 'start':
        if (this.status !== 'ready') return fail('invalid-state');
        this.status = 'running';
        this.notice = null;
        this.cover = this.withCover;
        if (this.linked) {
          // A faixa parte do início do slide escolhido e a sessão segue a posição confirmada.
          this.requestSeek(this.cueAt(this.index).startMs, this.index);
          return OK;
        }
        if (this.audioActive) {
          // Independente: volta ao ponto de partida (um teste de som pode ter andado) e
          // começa a tocar, em qualquer modo de avanço.
          const transport = this.transport as AudioTransport;
          const generation = ++this.seekGeneration;
          void transport.seek(this.initialAudioPosition()).then(
            () => {
              if (!this.disposed && generation === this.seekGeneration && this.status === 'running') this.playAudio();
            },
            () => undefined,
          );
        }
        this.restartInterval();
        this.beginManualTiming();
        return OK;
      case 'pause':
        if (this.status !== 'running') return fail('invalid-state');
        this.hold();
        this.pauseManualTiming();
        this.status = 'paused';
        if (this.linked) {
          this.transport?.pause();
        } else if (this.audioActive && this.followsPause && this.transport?.isPlaying()) {
          this.transport.pause();
          this.audioPausedBySession = true;
        }
        return OK;
      case 'resume':
        if (this.status !== 'paused') return fail('invalid-state');
        this.status = 'running';
        this.notice = null;
        if (this.linked) {
          this.playAudio();
        } else if (this.audioActive && this.audioPausedBySession) {
          this.audioPausedBySession = false;
          this.playAudio();
        }
        this.arm();
        this.beginManualTiming();
        return OK;
      case 'toggle': {
        if (this.status === 'ready') return this.run({ type: 'start' });
        const timed = this.mode === 'automatic' && this.currentDuration() !== null;
        // Sem duração atual no automático e sem faixa, não há o que tocar ou pausar.
        if (!timed && !this.audioActive) return fail('no-transport');
        if (this.separateTransport()) return this.toggleAudio();
        if (this.status === 'running') return this.run({ type: 'pause' });
        if (this.status === 'paused') return this.run({ type: 'resume' });
        if (this.status === 'finished') {
          if (this.linked) return this.run({ type: 'restartOccurrence' });
          this.status = 'running';
          this.restartInterval();
          return OK;
        }
        return fail('invalid-state');
      }
      case 'next':
        if (this.cover) return this.leaveCover();
        this.captureManualTiming(this.index + 1);
        return this.select(this.index + 1);
      case 'previous':
        if (this.cover) return fail('at-limit');
        return this.select(this.index - 1);
      case 'first':
        return this.select(0);
      case 'goTo': {
        const index = this.snapshot.occurrences.findIndex((occurrence) => occurrence.id === command.occurrenceId);
        return index < 0 ? fail('unknown-occurrence') : this.select(index);
      }
      case 'setMode':
        if (command.mode !== 'manual' && command.mode !== 'automatic') return fail('invalid-value');
        if (command.mode === this.mode) return OK;
        this.mode = command.mode;
        this.pauseManualTiming();
        if (this.linked) {
          // A faixa não é reposicionada: no automático os slides passam a seguir a
          // posição em que ela está; no manual, deixam de segui-la.
          this.accumulatedMs = 0;
          this.anchor = null;
          this.disarm();
          this.followAudio();
          return OK;
        }
        // Para o automático: intervalo completo. Para o manual: nenhum avanço armado.
        this.restartInterval();
        this.beginManualTiming();
        return OK;
      case 'completeManualTiming':
        return this.completeManualTiming();
      case 'restartOccurrence':
        if (this.status === 'finished') this.status = 'running';
        if (this.linked) {
          this.requestSeek(this.cueAt(this.index).startMs, this.index);
          return OK;
        }
        this.restartInterval();
        return OK;
      case 'stop':
        if (this.transport && this.audioActive) {
          // Interrompe a faixa em qualquer política e volta ao ponto de partida.
          this.seekGeneration += 1;
          this.playGeneration += 1;
          this.pendingSeek = null;
          this.audioPausedBySession = false;
          this.transport.pause();
          this.index = 0;
          void this.transport.seek(this.initialAudioPosition()).catch(() => undefined);
        }
        this.disarm();
        this.status = 'ready';
        this.cover = false;
        this.index = 0;
        this.accumulatedMs = 0;
        this.anchor = null;
        this.visualMode = 'normal';
        this.frozenFrame = null;
        this.notice = null;
        this.manualTiming.clear();
        this.manualTimingAnchor = null;
        this.manualTimingComplete = false;
        return OK;
      case 'setVisualMode':
        if (!['normal', 'black', 'lyricsHidden'].includes(command.visualMode)) return fail('invalid-value');
        this.visualMode = command.visualMode;
        return OK;
      case 'setFrozen':
        // Congela a imagem que o público vê agora; o relógio continua.
        this.frozenFrame = command.frozen ? (this.frozenFrame ?? this.liveFrame()) : null;
        return OK;
      case 'adjust':
        if (Object.keys(command.patch).length === 0 || visualPatchIssues(command.patch).length > 0) return fail('invalid-value');
        return this.adjust((state) => applyVisual(state, command.scope, currentId, command.patch));
      case 'resetAdjustment':
        return this.adjust((state) => resetVisual(state, command.scope, currentId, command.keys));
      case 'stepFontSize': {
        const size = steppedFontSize(this.slideAt(this.index).style.fontSizePx, command.direction);
        if (size === null) return fail('at-limit');
        return this.adjust((state) => applyVisual(state, command.scope, currentId, { fontSizePx: size }));
      }
      case 'setDuration': {
        if (!this.snapshot.occurrences.some((occurrence) => occurrence.id === command.occurrenceId)) return fail('unknown-occurrence');
        if (this.linked) return fail('audio-linked');
        const restartCurrent = command.occurrenceId === currentId;
        const durationBefore = this.currentDuration();
        const result = this.adjust((state) => applyDuration(state, command.occurrenceId, command.durationMs));
        // Reaplicar o mesmo valor no slide atual também reinicia a contagem.
        if (result.ok && restartCurrent && this.currentDuration() === durationBefore) this.restartInterval();
        return result;
      }
      case 'applyText':
        if (!this.snapshot.occurrences.some((occurrence) => occurrence.id === command.occurrenceId)) return fail('unknown-occurrence');
        if (typeof command.text !== 'string') return fail('invalid-value');
        return this.adjust((state) => applyText(state, command.occurrenceId, command.text));
      case 'setRotation':
        if (!isRotation(command.rotation)) return fail('invalid-value');
        this.rotation = command.rotation;
        return OK;
      case 'rotate':
        this.rotation = nextRotation(this.rotation);
        return OK;
      case 'undo':
        if (!canUndoOverrides(this.overrides)) return fail('nothing-to-undo');
        return this.adjust(undoOverrides);
      case 'restoreAppearance':
        return this.adjust(restoreAppearance);
      case 'audioPlay':
      case 'audioPause':
      case 'audioToggle': {
        if (!this.audioActive) return fail('no-audio');
        // Vinculada: o transporte é o da sessão. Antes de iniciar, serve de teste de som.
        if (this.linked && this.status !== 'ready') return fail('audio-linked');
        const playing = (this.transport as AudioTransport).isPlaying();
        if (command.type === 'audioPlay' ? playing : command.type === 'audioPause' ? !playing : false) return OK;
        return this.toggleAudio();
      }
      case 'audioSeek': {
        if (!this.audioActive) return fail('no-audio');
        if (this.linked) return fail('audio-linked');
        const duration = this.snapshot.audio?.durationMs ?? 0;
        if (!Number.isFinite(command.positionMs) || command.positionMs < 0 || command.positionMs > duration) return fail('invalid-value');
        this.requestSeek(command.positionMs, null);
        return OK;
      }
      case 'setVolume':
        if (!this.audioActive) return fail('no-audio');
        if (!(command.volume >= 0 && command.volume <= 1)) return fail('invalid-value');
        this.volume = command.volume;
        this.transport?.setVolume(command.volume);
        return OK;
      case 'setAudioFollowsPause':
        if (!this.audioActive) return fail('no-audio');
        if (typeof command.value !== 'boolean') return fail('invalid-value');
        this.followsPause = command.value;
        return OK;
      case 'applyLinkedTiming': {
        if (!this.linked) return fail('no-audio');
        // Nada reposiciona a música enquanto ela toca: aplicar exige a sessão em pausa.
        if (this.status === 'running') return fail('requires-pause');
        const known = new Set(this.snapshot.occurrences.map((occurrence) => occurrence.id));
        if (Object.keys(command.durations).some((id) => !known.has(id))) return fail('unknown-occurrence');
        const next = applyDurations(this.overrides, command.durations);
        if (!next) return fail('invalid-value');
        const sequence = this.snapshot.occurrences.map((occurrence, order) => ({ id: occurrence.id, order, durationMs: resolveSlide(this.snapshot, next.current, occurrence).durationMs }));
        const cues = deriveCues(sequence, this.snapshot.audio?.offsetMs ?? 0);
        if (!cues || linkIssues(sequence, cues, this.snapshot.audio?.durationMs ?? null).length > 0) return fail('invalid-timing');
        this.overrides = next;
        this.cues = cues;
        if (this.status === 'finished') this.status = 'paused';
        // Intervalos novos: a faixa vai, parada, para o início do slide atual.
        this.requestSeek(this.cueAt(this.index).startMs, this.index);
        return OK;
      }
      case 'unlinkAudio':
        if (!this.linked) return fail('no-audio');
        // A faixa continua de onde está; os slides passam a esperar o operador.
        this.seekGeneration += 1;
        this.pendingSeek = null;
        this.audioPolicy = 'independent';
        this.mode = 'manual';
        this.audioPausedBySession = this.status === 'paused';
        if (this.notice !== 'suspension-detected') this.notice = null;
        this.accumulatedMs = 0;
        this.anchor = null;
        this.disarm();
        return OK;
      case 'dropAudio':
        if (!this.audioActive) return fail('no-audio');
        this.seekGeneration += 1;
        this.playGeneration += 1;
        this.pendingSeek = null;
        this.transport?.pause();
        if (this.linked) this.mode = 'manual';
        this.audioPolicy = 'none';
        this.notice = null;
        this.accumulatedMs = 0;
        this.anchor = null;
        this.arm();
        return OK;
      default:
        return fail('invalid-value');
    }
  }
}
