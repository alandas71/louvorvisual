import { describe, expect, it } from 'vitest';
import { ManualTransport } from './audio';
import { ManualClock } from './clock';
import { PresentationEngine, type EngineOptions } from './engine';
import { audioSong } from './testing';

/** Deixa as promessas do transporte (seek, play) chegarem ao motor. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

function session(durations: readonly (number | null)[], audio: Parameters<typeof audioSong>[1], options: Partial<EngineOptions> = {}) {
  const prepared = audioSong(durations, audio);
  const clock = new ManualClock();
  const transport = new ManualTransport(clock, prepared.snapshot.audio?.durationMs ?? null);
  const engine = new PresentationEngine({ snapshot: prepared.snapshot, clock, sessionId: 'sessao', transport, ...options });
  const ids = prepared.snapshot.occurrences.map((occurrence) => occurrence.id);
  /** Avança o tempo em passos, entregando a posição da faixa como o `timeupdate` do navegador. */
  const play = async (ms: number, stepMs = 250) => {
    for (let done = 0; done < ms; done += stepMs) {
      clock.advance(Math.min(stepMs, ms - done));
      transport.tick();
      await flush();
    }
  };
  return { ...prepared, clock, transport, engine, ids, play };
}

describe('faixa independente', () => {
  it('trocar de slide não reposiciona a faixa; ela segue no seu transporte', async () => {
    const { engine, transport, play } = session([null, null, null], { policy: 'independent' }, { mode: 'manual' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    // Iniciar toca a faixa em qualquer modo de avanço.
    expect(transport.isPlaying()).toBe(true);
    await play(3000);
    const seeksBefore = transport.seekLog.length;
    engine.execute({ type: 'next' });
    engine.execute({ type: 'next' });
    engine.execute({ type: 'previous' });
    engine.execute({ type: 'first' });
    await play(2000);
    expect(transport.seekLog).toHaveLength(seeksBefore);
    expect(transport.positionMs()).toBe(5000);
    expect(transport.isPlaying()).toBe(true);
    expect(engine.getState()).toMatchObject({ audioPolicy: 'independent', clockSource: 'monotonic', currentIndex: 0 });
  });

  it('no automático começa a tocar do ponto de partida, e os slides seguem o próprio relógio', async () => {
    const { engine, transport, play } = session([4000, null, 6000], { policy: 'independent', offsetMs: 2000 }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.seekLog.at(-1)).toBe(2000);
    expect(transport.isPlaying()).toBe(true);
    await play(4000);
    // Slide sem tempo: o automático espera, a faixa continua e o play/pause permanece.
    expect(engine.getState()).toMatchObject({ currentIndex: 1, awaitingManualAdvance: true });
    expect(engine.getView().controls.capabilities).toEqual({ timerIndicator: false, countdown: false, transport: true });
    await play(5000);
    expect(engine.getState().currentIndex).toBe(1);
    expect(transport.positionMs()).toBe(11_000);
  });

  it('pausar a apresentação pausa a faixa junto, e retomar a devolve; com transporte separado, não', async () => {
    const { engine, transport, play } = session([8000, 8000], { policy: 'independent' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(2000);
    engine.execute({ type: 'pause' });
    expect(transport.isPlaying()).toBe(false);
    await play(3000);
    expect(transport.positionMs()).toBe(2000);
    engine.execute({ type: 'resume' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    expect(engine.remainingMs()).toBe(6000);

    expect(engine.execute({ type: 'setAudioFollowsPause', value: false })).toEqual({ ok: true });
    engine.execute({ type: 'pause' });
    expect(transport.isPlaying()).toBe(true);
    await play(1000);
    expect(transport.positionMs()).toBe(3000);
    // Quem o operador pausou à mão não volta sozinho ao retomar a sessão.
    engine.execute({ type: 'audioPause' });
    engine.execute({ type: 'resume' });
    await flush();
    expect(transport.isPlaying()).toBe(false);
  });

  it('sem relógio de slide (manual ou slide sem tempo), o play/pause compacto age só na faixa', async () => {
    const { engine, transport } = session([null, null], { policy: 'independent' }, { mode: 'manual' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    // Iniciar já toca a faixa; o play/pause compacto pausa e retoma só ela.
    expect(engine.getView().controls).toMatchObject({ playing: true, capabilities: { transport: true } });
    engine.execute({ type: 'toggle' });
    expect(transport.isPlaying()).toBe(false);
    expect(engine.getView().controls.playing).toBe(false);
    expect(engine.getState().status).toBe('running');
    engine.execute({ type: 'toggle' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    expect(engine.getState().status).toBe('running');
  });

  it('tela preta, ocultar letra, congelar e ajustes visuais não pausam nem reposicionam', async () => {
    const { engine, transport, play } = session([null, null], { policy: 'independent' }, { mode: 'manual' });
    await flush();
    engine.execute({ type: 'start' });
    engine.execute({ type: 'audioPlay' });
    await flush();
    const seeks = transport.seekLog.length;
    await play(1000);
    engine.execute({ type: 'setVisualMode', visualMode: 'black' });
    engine.execute({ type: 'setVisualMode', visualMode: 'lyricsHidden' });
    engine.execute({ type: 'setFrozen', frozen: true });
    engine.execute({ type: 'stepFontSize', direction: 1, scope: 'occurrence' });
    engine.execute({ type: 'adjust', scope: 'song', patch: { themePresetId: 'vinho', fontId: 'lato' } });
    engine.execute({ type: 'rotate' });
    await play(1000);
    expect(transport.isPlaying()).toBe(true);
    expect(transport.positionMs()).toBe(2000);
    expect(transport.seekLog).toHaveLength(seeks);
  });

  it('fim visual mantém a faixa tocando; parar a interrompe e volta ao estado preparado', async () => {
    const { engine, transport, play } = session([1000, 1000], { policy: 'independent', offsetMs: 500 }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(2500);
    expect(engine.getState().status).toBe('finished');
    expect(transport.isPlaying()).toBe(true);
    expect(engine.getView().controls.audio).toMatchObject({ playing: true, policy: 'independent' });
    engine.execute({ type: 'stop' });
    await flush();
    expect(engine.getState()).toMatchObject({ status: 'ready', currentIndex: 0 });
    expect(transport.isPlaying()).toBe(false);
    expect(transport.positionMs()).toBe(500);
  });

  it('volume vale no player e é recusado fora de 0 a 1', () => {
    const { engine, transport } = session([null], { policy: 'independent', volume: 0.6 });
    expect(transport.volume).toBe(0.6);
    expect(engine.execute({ type: 'setVolume', volume: 0.25 })).toEqual({ ok: true });
    expect(transport.volume).toBe(0.25);
    expect(engine.execute({ type: 'setVolume', volume: 1.5 })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(engine.getView().controls.audio?.volume).toBe(0.25);
  });
});

describe('faixa vinculada no automático', () => {
  const EXAMPLE = [8000, 12_000, 10_000] as const;

  it('exemplo do planejamento: deslocamento de 5 s; os slides acompanham a posição da faixa', async () => {
    const { engine, transport, play, snapshot } = session(EXAMPLE, { policy: 'linked', offsetMs: 5000 }, { mode: 'automatic' });
    expect(snapshot.audio?.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([[5000, 13_000], [13_000, 25_000], [25_000, 35_000]]);
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.seekLog.at(-1)).toBe(5000);
    expect(transport.isPlaying()).toBe(true);
    expect(engine.getState()).toMatchObject({ status: 'running', clockSource: 'audio', audioPolicy: 'linked', currentIndex: 0 });

    await play(7900);
    expect(engine.getState()).toMatchObject({ currentIndex: 0, elapsedInSlideMs: 7900 });
    expect(engine.remainingMs()).toBe(100);
    await play(100);
    expect(engine.getState().currentIndex).toBe(1);
    expect(transport.positionMs()).toBe(13_000);
    await play(12_000);
    expect(engine.getState().currentIndex).toBe(2);
    await play(9900);
    expect(engine.getState().status).toBe('running');
    await play(100);
    // Fim planejado: último slide na tela e faixa parada ali, mesmo com gravação sobrando.
    expect(engine.getState()).toMatchObject({ status: 'finished', currentIndex: 2 });
    expect(transport.isPlaying()).toBe(false);
    expect(transport.positionMs()).toBe(35_000);
  });

  it('não há segundo cronômetro: faixa travada congela os slides e o contador', async () => {
    const { engine, transport, clock, play } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(6000);
    transport.stall();
    expect(engine.getView().notice).toBe('audio-stalled');
    // O relógio do processo anda 30 s; a faixa, não.
    clock.advance(30_000);
    await flush();
    expect(engine.getState()).toMatchObject({ currentIndex: 0, status: 'running', elapsedInSlideMs: 6000 });
    expect(engine.remainingMs()).toBe(2000);
    transport.unstall();
    expect(engine.getView().notice).toBeNull();
    await play(2000);
    expect(engine.getState().currentIndex).toBe(1);
  });

  it('salto: reposiciona no início do destino, espera a confirmação e continua em execução', async () => {
    const { engine, transport, play, ids } = session(EXAMPLE, { policy: 'linked', offsetMs: 5000 }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(6000);
    transport.autoConfirm = false;
    expect(engine.execute({ type: 'goTo', occurrenceId: ids[2]! })).toEqual({ ok: true });
    // Pedido feito, ainda não confirmado: o slide exibido continua o último confirmado.
    expect(transport.seekLog.at(-1)).toBe(25_000);
    expect(engine.getState().currentIndex).toBe(0);
    expect(engine.getView().controls.audio?.seeking).toBe(true);
    // A posição antiga segue andando e não muda a seleção durante o reposicionamento.
    await play(3000);
    expect(engine.getState().currentIndex).toBe(0);
    transport.confirmSeek();
    await flush();
    expect(engine.getState()).toMatchObject({ currentIndex: 2, status: 'running', elapsedInSlideMs: 0 });
    expect(engine.getView().controls.audio?.seeking).toBe(false);
    expect(transport.isPlaying()).toBe(true);
    await play(10_000);
    expect(engine.getState().status).toBe('finished');
  });

  it('saltos rápidos: só o destino mais recente vale; confirmação de seek antigo é descartada', async () => {
    const { engine, transport, ids } = session([4000, 4000, 4000, 4000], { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    transport.autoConfirm = false;
    const sequenceBefore = engine.getState().sequenceNumber;
    engine.execute({ type: 'goTo', occurrenceId: ids[1]! });
    engine.execute({ type: 'goTo', occurrenceId: ids[3]! });
    engine.execute({ type: 'goTo', occurrenceId: ids[2]! });
    expect(transport.seekLog.slice(-3)).toEqual([4000, 12_000, 8000]);
    expect(transport.pendingSeeks).toBe(1);
    await flush();
    // Os dois primeiros foram substituídos: não mostram destino nem aviso de falha.
    expect(engine.getState().currentIndex).toBe(0);
    expect(engine.getView().notice).toBeNull();
    transport.confirmSeek();
    await flush();
    expect(engine.getState().currentIndex).toBe(2);
    expect(transport.positionMs()).toBe(8000);
    expect(engine.getState().sequenceNumber).toBeGreaterThan(sequenceBefore);
  });

  it('em pausa, o salto fica parado no início do destino', async () => {
    const { engine, transport, play, ids } = session(EXAMPLE, { policy: 'linked', offsetMs: 5000 }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(2000);
    engine.execute({ type: 'pause' });
    expect(transport.isPlaying()).toBe(false);
    engine.execute({ type: 'goTo', occurrenceId: ids[1]! });
    await flush();
    await play(4000);
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 1, elapsedInSlideMs: 0 });
    expect(transport.positionMs()).toBe(13_000);
    expect(transport.isPlaying()).toBe(false);
    engine.execute({ type: 'resume' });
    await flush();
    await play(12_000);
    expect(engine.getState().currentIndex).toBe(2);
  });

  it('seek que falha: em pausa, no último estado confirmado, e pode tentar de novo', async () => {
    const { engine, transport, play, ids } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(1000);
    transport.autoConfirm = false;
    engine.execute({ type: 'goTo', occurrenceId: ids[2]! });
    transport.failSeek();
    await flush();
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 0 });
    expect(engine.getView().notice).toBe('seek-failed');
    expect(transport.isPlaying()).toBe(false);
    transport.autoConfirm = true;
    engine.execute({ type: 'goTo', occurrenceId: ids[2]! });
    await flush();
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 2 });
    expect(engine.getView().notice).toBeNull();
  });

  it('pausa pausa a faixa; pausa vinda de fora também para os slides', async () => {
    const { engine, transport, play } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(3000);
    engine.execute({ type: 'pause' });
    await play(20_000);
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 0, elapsedInSlideMs: 3000 });
    engine.execute({ type: 'resume' });
    await flush();
    await play(1000);
    transport.externalPause();
    expect(engine.getState().status).toBe('paused');
    await play(20_000);
    expect(engine.getState().currentIndex).toBe(0);
  });

  it('gravação que acaba antes do previsto pausa a sessão e oferece seguir à mão', async () => {
    // Intervalos de uma gravação de 30 s usados com um player que só tem 20 s.
    const prepared = audioSong(EXAMPLE, { policy: 'linked', trackMs: 30_000 });
    const clock = new ManualClock();
    const transport = new ManualTransport(clock, 20_000);
    const engine = new PresentationEngine({ snapshot: prepared.snapshot, clock, sessionId: 'sessao', transport, mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    for (let done = 0; done < 21_000; done += 500) {
      clock.advance(500);
      transport.tick();
      await flush();
    }
    // Aos 20 s a gravação acabou no começo do terceiro intervalo (20–30 s), não no fim planejado.
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 2 });
    expect(engine.getView().notice).toBe('audio-ended-early');
    expect(engine.execute({ type: 'dropAudio' })).toEqual({ ok: true });
    expect(engine.getState()).toMatchObject({ audioPolicy: 'none', mode: 'manual', currentIndex: 2, status: 'paused' });
    expect(engine.execute({ type: 'previous' })).toEqual({ ok: true });
    expect(engine.getState().currentIndex).toBe(1);
  });

  it('falha da faixa pausa o motor', async () => {
    const { engine, transport, play } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(1000);
    transport.fail('unplayable');
    expect(engine.getState().status).toBe('paused');
    expect(engine.getView().notice).toBe('audio-failed');
  });

  it('autoplay bloqueado: a sessão não finge que anda e retoma com o gesto do operador', async () => {
    const { engine, transport, play } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    transport.playBlocked = true;
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 0 });
    expect(engine.getView().notice).toBe('autoplay-blocked');
    expect(transport.isPlaying()).toBe(false);
    transport.playBlocked = false;
    engine.execute({ type: 'resume' });
    await flush();
    expect(engine.getView().notice).toBeNull();
    await play(8000);
    expect(engine.getState().currentIndex).toBe(1);
  });

  it('ajustes visuais ao vivo não pausam nem reposicionam a faixa vinculada', async () => {
    const { engine, transport, play } = session(EXAMPLE, { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    const seeks = transport.seekLog.length;
    await play(2000);
    engine.execute({ type: 'stepFontSize', direction: -1, scope: 'occurrence' });
    engine.execute({ type: 'adjust', scope: 'song', patch: { themePresetId: 'petroleo' } });
    engine.execute({ type: 'rotate' });
    engine.execute({ type: 'applyText', occurrenceId: engine.getState().currentOccurrenceId, text: 'Outro texto' });
    await play(6000);
    expect(transport.seekLog).toHaveLength(seeks);
    expect(engine.getState()).toMatchObject({ currentIndex: 1, status: 'running' });
  });
});

describe('faixa vinculada no manual', () => {
  it('saltos reposicionam; a faixa não avança slides e toca além da duração visual', async () => {
    const { engine, transport, play } = session([4000, 4000, 4000], { policy: 'linked' }, { mode: 'manual' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    await play(9000);
    expect(engine.getState()).toMatchObject({ currentIndex: 0, clockSource: 'monotonic', audioPolicy: 'linked' });
    expect(transport.positionMs()).toBe(9000);
    engine.execute({ type: 'next' });
    await flush();
    expect(engine.getState().currentIndex).toBe(1);
    expect(transport.positionMs()).toBe(4000);
    expect(transport.isPlaying()).toBe(true);
  });

  it('passar ao automático faz os slides seguirem a posição em que a faixa está, sem seek', async () => {
    const { engine, transport, play } = session([4000, 4000, 4000], { policy: 'linked' }, { mode: 'manual' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(9000);
    const seeks = transport.seekLog.length;
    engine.execute({ type: 'setMode', mode: 'automatic' });
    expect(transport.seekLog).toHaveLength(seeks);
    expect(engine.getState()).toMatchObject({ currentIndex: 2, clockSource: 'audio' });
  });
});

describe('tempo com faixa vinculada (planejamento/20)', () => {
  it('alterar ou remover tempo direto é recusado e não toca na faixa', async () => {
    const { engine, transport, play, ids } = session([8000, 12_000, 10_000], { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(2000);
    const seeks = transport.seekLog.length;
    expect(engine.execute({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 4000 })).toEqual({ ok: false, reason: 'audio-linked' });
    expect(engine.execute({ type: 'setDuration', occurrenceId: ids[1]!, durationMs: null })).toEqual({ ok: false, reason: 'audio-linked' });
    expect(transport.seekLog).toHaveLength(seeks);
    expect(transport.positionMs()).toBe(2000);
    expect(engine.getView().slides.map((slide) => slide.durationMs)).toEqual([8000, 12_000, 10_000]);
  });

  it('aplicar a revisão pede pausa, revalida os intervalos contra a gravação e reposiciona parado', async () => {
    const { engine, transport, play, ids } = session([8000, 12_000, 10_000], { policy: 'linked', offsetMs: 5000, trackMs: 40_000 }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(9000);
    expect(engine.getState().currentIndex).toBe(1);
    const seeks = transport.seekLog.length;

    expect(engine.execute({ type: 'applyLinkedTiming', durations: { [ids[0]!]: 6000 } })).toEqual({ ok: false, reason: 'requires-pause' });
    engine.execute({ type: 'pause' });
    // 5 + 8 + 12 + 20 = 45 s não cabe em uma gravação de 40 s.
    expect(engine.execute({ type: 'applyLinkedTiming', durations: { [ids[2]!]: 20_000 } })).toEqual({ ok: false, reason: 'invalid-timing' });
    expect(engine.execute({ type: 'applyLinkedTiming', durations: { [ids[0]!]: 100 } })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(engine.execute({ type: 'applyLinkedTiming', durations: { desconhecido: 4000 } })).toEqual({ ok: false, reason: 'unknown-occurrence' });
    expect(transport.seekLog).toHaveLength(seeks);
    expect(engine.getView().slides.map((slide) => slide.durationMs)).toEqual([8000, 12_000, 10_000]);

    expect(engine.execute({ type: 'applyLinkedTiming', durations: { [ids[0]!]: 6000, [ids[1]!]: 10_000 } })).toEqual({ ok: true });
    await flush();
    expect(engine.getView().slides.map((slide) => slide.durationMs)).toEqual([6000, 10_000, 10_000]);
    expect(engine.checkpoint().audio?.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([[5000, 11_000], [11_000, 21_000], [21_000, 31_000]]);
    // Parado no início do slide atual, já no intervalo novo.
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 1 });
    expect(transport.positionMs()).toBe(11_000);
    expect(transport.isPlaying()).toBe(false);
    engine.execute({ type: 'resume' });
    await flush();
    await play(10_000);
    expect(engine.getState().currentIndex).toBe(2);
  });

  it('desvincular preserva a posição, passa ao avanço manual e então aceita remover tempo', async () => {
    const { engine, transport, play, ids } = session([8000, 12_000, 10_000], { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(9500);
    const seeks = transport.seekLog.length;
    expect(engine.execute({ type: 'unlinkAudio' })).toEqual({ ok: true });
    expect(engine.getState()).toMatchObject({ audioPolicy: 'independent', mode: 'manual', currentIndex: 1, status: 'running', clockSource: 'monotonic' });
    expect(transport.seekLog).toHaveLength(seeks);
    expect(transport.isPlaying()).toBe(true);
    expect(transport.positionMs()).toBe(9500);
    expect(engine.execute({ type: 'setDuration', occurrenceId: ids[1]!, durationMs: null })).toEqual({ ok: true });
    await play(30_000);
    // A faixa segue; os slides esperam o operador.
    expect(engine.getState().currentIndex).toBe(1);
    expect(transport.positionMs()).toBe(39_500);
    expect(transport.seekLog).toHaveLength(seeks);
  });

  it('desfazer que mudaria tempos é recusado enquanto a faixa está vinculada', async () => {
    const { engine, ids } = session([8000, 12_000], { policy: 'linked' }, { mode: 'automatic' });
    await flush();
    engine.execute({ type: 'applyLinkedTiming', durations: { [ids[0]!]: 6000 } });
    await flush();
    expect(engine.execute({ type: 'undo' })).toEqual({ ok: false, reason: 'audio-linked' });
    engine.execute({ type: 'stepFontSize', direction: 1, scope: 'occurrence' });
    expect(engine.execute({ type: 'undo' })).toEqual({ ok: true });
  });
});

describe('preparação, recuperação e suspensão', () => {
  it('vínculo com último intervalo além do fim da gravação é impedido: a faixa segue independente, com aviso', () => {
    const { snapshot, warnings } = audioSong([8000, 12_000, 10_000], { policy: 'linked', offsetMs: 5000, trackMs: 34_000 });
    expect(warnings).toContain('audio-link-unavailable');
    expect(snapshot.audio).toMatchObject({ policy: 'independent', cues: [] });
  });

  it('sem player (arquivo indisponível), a sessão segue sem áudio', () => {
    const { snapshot } = audioSong([8000, 8000], { policy: 'linked' });
    const engine = new PresentationEngine({ snapshot, clock: new ManualClock(), sessionId: 'sessao', mode: 'automatic' });
    expect(engine.getState().audioPolicy).toBe('none');
    expect(engine.getView().controls.audio).toBeNull();
    expect(engine.execute({ type: 'audioToggle' })).toEqual({ ok: false, reason: 'no-audio' });
    expect(engine.execute({ type: 'start' })).toEqual({ ok: true });
    expect(engine.remainingMs()).toBe(8000);
  });

  it('antes de iniciar, o play serve de teste de som e iniciar volta ao ponto de partida', async () => {
    const { engine, transport, play } = session([8000, 8000], { policy: 'linked', offsetMs: 1000 }, { mode: 'automatic' });
    await flush();
    expect(transport.positionMs()).toBe(1000);
    engine.execute({ type: 'audioToggle' });
    await flush();
    await play(3000);
    expect(engine.getState()).toMatchObject({ status: 'ready', currentIndex: 0 });
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.positionMs()).toBe(1000);
    expect(engine.getState()).toMatchObject({ status: 'running', elapsedInSlideMs: 0 });
  });

  it('recuperar volta em pausa, com a faixa parada na posição guardada', async () => {
    const first = session([8000, 12_000, 10_000], { policy: 'linked', offsetMs: 5000 }, { mode: 'automatic' });
    await flush();
    first.engine.execute({ type: 'start' });
    await flush();
    await first.play(10_000);
    first.engine.execute({ type: 'setVolume', volume: 0.4 });
    const checkpoint = JSON.parse(JSON.stringify(first.engine.checkpoint()));
    expect(checkpoint).toMatchObject({ status: 'running', audio: { policy: 'linked', positionMs: 15_000, volume: 0.4 } });

    const clock = new ManualClock();
    const transport = new ManualTransport(clock, 60_000);
    const engine = new PresentationEngine({ snapshot: first.snapshot, clock, sessionId: 'sessao', transport, checkpoint });
    await flush();
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 1, audioPolicy: 'linked' });
    expect(transport.isPlaying()).toBe(false);
    expect(transport.positionMs()).toBe(15_000);
    expect(transport.volume).toBe(0.4);
    clock.advance(20_000);
    transport.tick();
    expect(engine.getState().currentIndex).toBe(1);
    engine.execute({ type: 'resume' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    expect(engine.getState().elapsedInSlideMs).toBe(2000);
  });

  it('suspensão detectada pausa a sessão e a faixa, em qualquer política', async () => {
    for (const policy of ['linked', 'independent'] as const) {
      const { engine, transport, play } = session([8000, 8000], { policy }, { mode: 'automatic' });
      await flush();
      engine.execute({ type: 'start' });
      await flush();
      await play(2000);
      engine.notifySuspension();
      expect(engine.getState().status, policy).toBe('paused');
      expect(engine.getView().notice).toBe('suspension-detected');
      expect(transport.isPlaying(), policy).toBe(false);
      engine.execute({ type: 'resume' });
      await flush();
      expect(transport.isPlaying(), policy).toBe(true);
    }
  });
});

describe('abertura com faixa', () => {
  it('independente: Iniciar toca a faixa na abertura e avançar não a reposiciona', async () => {
    const { engine, transport, play } = session([2000, 2000], { policy: 'independent' }, { mode: 'automatic', cover: true });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    await play(5000);
    // O tempo do slide não corre na abertura: a sessão continua no primeiro slide.
    expect(engine.getState()).toMatchObject({ status: 'running', cover: true, currentIndex: 0 });
    const seeks = transport.seekLog.length;
    engine.execute({ type: 'next' });
    expect(engine.getState()).toMatchObject({ cover: false, currentIndex: 0 });
    await play(2000);
    expect(engine.getState().currentIndex).toBe(1);
    expect(transport.seekLog).toHaveLength(seeks);
    expect(transport.isPlaying()).toBe(true);
  });

  it('vinculada: a letra só segue a faixa depois de avançar, e entra onde a música está', async () => {
    const { engine, transport, play } = session([2000, 2000, 2000], { policy: 'linked' }, { mode: 'automatic', cover: true });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(transport.isPlaying()).toBe(true);
    await play(2500);
    expect(engine.getState()).toMatchObject({ cover: true, currentIndex: 0 });
    const seeks = transport.seekLog.length;
    engine.execute({ type: 'next' });
    expect(engine.getState()).toMatchObject({ cover: false, currentIndex: 1, clockSource: 'audio' });
    expect(transport.seekLog).toHaveLength(seeks);
    await play(2000);
    expect(engine.getState().currentIndex).toBe(2);
  });
});

describe('temporizador da introdução com faixa', () => {
  function intro(policy: 'independent' | 'linked', introDurationMs: number, audio: { offsetMs?: number } = {}) {
    const prepared = audioSong([8000, 8000], { policy, ...audio });
    const snapshot = { ...prepared.snapshot, arrangement: { ...prepared.snapshot.arrangement, introDurationMs } };
    const clock = new ManualClock();
    const transport = new ManualTransport(clock, snapshot.audio?.durationMs ?? null);
    const engine = new PresentationEngine({ snapshot, clock, sessionId: 'sessao', transport, mode: 'automatic', cover: true });
    const play = async (ms: number, stepMs = 250) => {
      for (let done = 0; done < ms; done += stepMs) {
        clock.advance(Math.min(stepMs, ms - done));
        transport.tick();
        await flush();
      }
    };
    return { clock, transport, engine, play };
  }

  it('a letra entra quando a música chega ao tempo da introdução, não pelo relógio da sessão', async () => {
    const { engine, transport, clock, play } = intro('independent', 5000);
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(engine.getState().cover).toBe(true);
    await play(2000);
    expect(engine.remainingMs()).toBe(3000);
    // A faixa para por fora: o relógio anda, a música não, e a abertura continua.
    transport.pause();
    clock.advance(60_000);
    await flush();
    expect(engine.getState().cover).toBe(true);
    await transport.play();
    await play(2750);
    expect(engine.getState().cover).toBe(true);
    await play(250);
    expect(engine.getState()).toMatchObject({ cover: false, currentIndex: 0 });
    // A faixa nunca é reposicionada para a letra entrar: só os pedidos de preparar e de iniciar.
    expect(transport.seekLog).toEqual([0, 0]);
  });

  it('o tempo é o da música: com ponto de partida adiantado, falta só o que resta até lá', async () => {
    const { engine, play } = intro('independent', 5000, { offsetMs: 3000 });
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    expect(engine.remainingMs()).toBe(2000);
    await play(1750);
    expect(engine.getState().cover).toBe(true);
    await play(250);
    expect(engine.getState().cover).toBe(false);
  });

  it('reposicionar a faixa para depois da introdução mostra a letra', async () => {
    const { engine, play } = intro('independent', 5000);
    await flush();
    engine.execute({ type: 'start' });
    await flush();
    await play(1000);
    engine.execute({ type: 'audioSeek', positionMs: 9000 });
    await flush();
    await play(250);
    expect(engine.getState().cover).toBe(false);
  });
});
