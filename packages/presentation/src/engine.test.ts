import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { PresentationEngine, SUSPENSION_THRESHOLD_MS, type OperatorCommand } from './engine';
import { timedSong } from './testing';

const S = 1000;

function session(durations: readonly (number | null)[], mode: 'manual' | 'automatic' = 'automatic') {
  const { snapshot } = timedSong(durations);
  const clock = new ManualClock();
  const engine = new PresentationEngine({ snapshot, clock, sessionId: 'session-1', mode });
  const run = (command: OperatorCommand) => engine.execute(command);
  const at = () => engine.getState();
  return { snapshot, clock, engine, run, at, ids: snapshot.occurrences.map((item) => item.id) };
}

describe('modo manual (AT-04)', () => {
  it('não avança sem comando, mesmo com tempo configurado', () => {
    const { clock, run, at } = session([8 * S, 12 * S, 10 * S], 'manual');
    run({ type: 'start' });
    clock.advance(600 * S);
    expect(at()).toMatchObject({ status: 'running', currentIndex: 0, elapsedInSlideMs: 0, awaitingManualAdvance: false });
    expect(clock.armed).toBe(0);
    run({ type: 'next' });
    expect(at().currentIndex).toBe(1);
    clock.advance(600 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('anterior no primeiro e próximo no último não saem da sequência', () => {
    const { run, at } = session([null, null], 'manual');
    run({ type: 'start' });
    expect(run({ type: 'previous' })).toEqual({ ok: false, reason: 'at-limit' });
    run({ type: 'next' });
    expect(run({ type: 'next' })).toEqual({ ok: false, reason: 'at-limit' });
    expect(at()).toMatchObject({ currentIndex: 1, status: 'running' });
  });

  it('antes de iniciar o público vê preto; iniciar mostra o destino escolhido', () => {
    const { engine, run, ids } = session([null, null, null], 'manual');
    run({ type: 'goTo', occurrenceId: ids[2]! });
    expect(engine.getView().output).toMatchObject({ visualMode: 'black', index: 2 });
    expect(engine.getState().status).toBe('ready');
    run({ type: 'start' });
    expect(engine.getView().output).toMatchObject({ visualMode: 'normal', index: 2 });
  });

  it('aprende os avanços sequenciais e prepara o padrão automático no último slide', () => {
    const { clock, engine, run, ids } = session([null, null, null], 'manual');
    run({ type: 'start' });
    clock.advance(4 * S);
    run({ type: 'next' });
    clock.advance(7 * S);
    run({ type: 'next' });
    clock.advance(9 * S);
    expect(run({ type: 'completeManualTiming' })).toEqual({ ok: true });
    expect(engine.getState().manualTiming).toEqual({ active: false, complete: true, captured: 3, total: 3 });
    expect(engine.getOverrides().occurrences).toMatchObject({
      [ids[0]!]: { durationMs: 4 * S },
      [ids[1]!]: { durationMs: 7 * S },
      [ids[2]!]: { durationMs: 9 * S },
    });
  });
});

describe('automático 8, 12 e 10 segundos (AT-05)', () => {
  it('respeita cada intervalo e termina no último slide', () => {
    const { clock, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.advance(7999);
    expect(at()).toMatchObject({ currentIndex: 0, elapsedInSlideMs: 7999 });
    clock.advance(1);
    expect(at()).toMatchObject({ currentIndex: 1, elapsedInSlideMs: 0 });
    clock.advance(11_999);
    expect(at().currentIndex).toBe(1);
    clock.advance(1);
    expect(at().currentIndex).toBe(2);
    clock.advance(9999);
    expect(at().status).toBe('running');
    clock.advance(1);
    expect(at()).toMatchObject({ status: 'finished', currentIndex: 2 });
    clock.advance(60 * S);
    expect(at()).toMatchObject({ status: 'finished', currentIndex: 2 });
    expect(clock.armed).toBe(0);
  });

  it('pausa guarda a posição e retomar continua do tempo restante', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.advance(5 * S);
    run({ type: 'pause' });
    expect(at()).toMatchObject({ status: 'paused', elapsedInSlideMs: 5 * S });
    clock.advance(60 * S);
    expect(at()).toMatchObject({ status: 'paused', currentIndex: 0, elapsedInSlideMs: 5 * S });
    run({ type: 'resume' });
    expect(engine.remainingMs()).toBe(3 * S);
    clock.advance(2999);
    expect(at().currentIndex).toBe(0);
    clock.advance(1);
    expect(at().currentIndex).toBe(1);
  });

  it('callback atrasado consome os intervalos vencidos sem somar durações inteiras', () => {
    const { clock, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    // O despertador de 8 s só roda aos 9,5 s: B já começou há 1,5 s.
    clock.jump(9500);
    expect(at()).toMatchObject({ currentIndex: 1, elapsedInSlideMs: 1500 });
    clock.advance(10_499);
    expect(at().currentIndex).toBe(1);
    clock.advance(1);
    expect(at()).toMatchObject({ currentIndex: 2, elapsedInSlideMs: 0 });
  });

  it('atraso que cobre mais de um slide curto chega à ocorrência do tempo real', () => {
    const { clock, run, at } = session([1 * S, 1 * S, 1 * S, 30 * S]);
    run({ type: 'start' });
    clock.jump(3500);
    expect(at()).toMatchObject({ currentIndex: 3, elapsedInSlideMs: 500, status: 'running' });
  });

  it('ausência prolongada de callbacks retoma em pausa, sem acelerar slides vencidos', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.jump(8 * S + SUSPENSION_THRESHOLD_MS + 1);
    expect(at()).toMatchObject({ status: 'paused', currentIndex: 0, elapsedInSlideMs: 0 });
    expect(engine.getView().notice).toBe('suspension-detected');
    run({ type: 'resume' });
    expect(engine.getView().notice).toBeNull();
    clock.advance(8 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('acordar antes da hora só rearma', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(3 * S);
    engine.reconcile();
    expect(at()).toMatchObject({ currentIndex: 0, elapsedInSlideMs: 3 * S });
    clock.advance(5 * S);
    expect(at().currentIndex).toBe(1);
  });
});

describe('navegar durante o automático (AT-06)', () => {
  it('exemplo obrigatório: salto começa o intervalo completo do destino e o modo continua', () => {
    const { clock, engine, run, at, ids } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'goTo', occurrenceId: ids[1]! });
    expect(at()).toMatchObject({ currentIndex: 1, elapsedInSlideMs: 0, mode: 'automatic', status: 'running' });
    expect(engine.remainingMs()).toBe(12 * S);
    // O despertador antigo de A (faltavam 2 s) não pode avançar B.
    clock.advance(2 * S);
    expect(at().currentIndex).toBe(1);
    clock.advance(10 * S);
    expect(at()).toMatchObject({ currentIndex: 2, elapsedInSlideMs: 0 });
    expect(engine.remainingMs()).toBe(10 * S);

    run({ type: 'previous' });
    run({ type: 'previous' });
    expect(at()).toMatchObject({ currentIndex: 0, mode: 'automatic', status: 'running' });
    expect(engine.remainingMs()).toBe(8 * S);
    clock.advance(8 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('pausado: o salto escolhe o destino, zera o tempo e continua pausado', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'pause' });
    run({ type: 'next' });
    expect(at()).toMatchObject({ status: 'paused', currentIndex: 1, elapsedInSlideMs: 0 });
    clock.advance(60 * S);
    expect(at()).toMatchObject({ status: 'paused', currentIndex: 1 });
    run({ type: 'resume' });
    expect(engine.remainingMs()).toBe(12 * S);
  });

  it('selecionar de novo o slide atual reinicia seu intervalo', () => {
    const { clock, engine, run, ids } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(5 * S);
    run({ type: 'goTo', occurrenceId: ids[0]! });
    expect(engine.remainingMs()).toBe(8 * S);
  });

  it('sair do fim por navegação volta a executar', () => {
    const { clock, run, at } = session([1 * S, 1 * S]);
    run({ type: 'start' });
    clock.advance(2 * S);
    expect(at().status).toBe('finished');
    run({ type: 'previous' });
    expect(at()).toMatchObject({ status: 'running', currentIndex: 0 });
    clock.advance(1 * S);
    expect(at().currentIndex).toBe(1);
  });
});

describe('tempo opcional (AT-27, apresentação)', () => {
  it('8 s → sem tempo → 12 s: para no slide sem tempo e o próximo temporizado retoma', () => {
    const { clock, engine, run, at } = session([8 * S, null, 12 * S, null]);
    run({ type: 'start' });
    expect(engine.getView().controls.capabilities).toEqual({ timerIndicator: true, countdown: true, transport: true });
    clock.advance(8 * S);
    expect(at()).toMatchObject({ currentIndex: 1, awaitingManualAdvance: true, mode: 'automatic', status: 'running', elapsedInSlideMs: 0 });
    // Sem indicador, sem contagem e sem play/pause: não há duração inventada.
    expect(engine.getView().controls.capabilities).toEqual({ timerIndicator: false, countdown: false, transport: false });
    expect(engine.remainingMs()).toBeNull();
    expect(clock.armed).toBe(0);
    clock.advance(3600 * S);
    expect(at().currentIndex).toBe(1);

    run({ type: 'next' });
    expect(at()).toMatchObject({ currentIndex: 2, awaitingManualAdvance: false });
    expect(engine.remainingMs()).toBe(12 * S);
    clock.advance(12 * S);
    expect(at()).toMatchObject({ currentIndex: 3, awaitingManualAdvance: true, status: 'running' });
  });

  it('atraso de callback não atravessa um slide sem tempo', () => {
    const { clock, run, at } = session([1 * S, null, 1 * S]);
    run({ type: 'start' });
    clock.jump(4 * S);
    expect(at()).toMatchObject({ currentIndex: 1, awaitingManualAdvance: true });
  });

  it('null nunca vira zero: iniciar em automático num slide sem tempo só aguarda', () => {
    const { clock, run, at } = session([null, 8 * S]);
    run({ type: 'start' });
    clock.advance(0);
    expect(at()).toMatchObject({ currentIndex: 0, awaitingManualAdvance: true });
    expect(run({ type: 'toggle' })).toEqual({ ok: false, reason: 'no-transport' });
    expect(at().status).toBe('running');
  });

  it('aplicar duração no slide atual reinicia o intervalo completo; pausado continua pausado', () => {
    const { clock, engine, run, at, ids } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 20 * S });
    expect(engine.remainingMs()).toBe(20 * S);
    clock.advance(8 * S);
    expect(at().currentIndex).toBe(0);
    run({ type: 'pause' });
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 5 * S });
    expect(at()).toMatchObject({ status: 'paused', elapsedInSlideMs: 0 });
    clock.advance(60 * S);
    expect(at().currentIndex).toBe(0);
    run({ type: 'resume' });
    clock.advance(5 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('reaplicar o mesmo valor também reinicia a contagem do slide atual', () => {
    const { clock, engine, run, ids } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 8 * S });
    expect(engine.remainingMs()).toBe(8 * S);
  });

  it('alterar um slide futuro não mexe no andamento atual', () => {
    const { clock, engine, run, at, ids } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'setDuration', occurrenceId: ids[1]!, durationMs: 3 * S });
    expect(engine.remainingMs()).toBe(2 * S);
    clock.advance(2 * S);
    expect(at().currentIndex).toBe(1);
    expect(engine.remainingMs()).toBe(3 * S);
  });

  it('remover o tempo do slide atual desarma o avanço e aguarda; adicionar em execução começa o intervalo', () => {
    const { clock, engine, run, at, ids } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(6 * S);
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: null });
    expect(at()).toMatchObject({ awaitingManualAdvance: true, mode: 'automatic', status: 'running' });
    clock.advance(60 * S);
    expect(at().currentIndex).toBe(0);
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 4 * S });
    expect(engine.remainingMs()).toBe(4 * S);
    clock.advance(4 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('em manual, adicionar tempo só prepara o valor', () => {
    const { clock, engine, run, at, ids } = session([null, null], 'manual');
    run({ type: 'start' });
    run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs: 1 * S });
    clock.advance(60 * S);
    expect(at().currentIndex).toBe(0);
    expect(engine.getView().controls.capabilities).toEqual({ timerIndicator: true, countdown: false, transport: false });
    // Ativar o automático recupera o transporte e começa o intervalo completo.
    run({ type: 'setMode', mode: 'automatic' });
    expect(engine.getView().controls.capabilities.transport).toBe(true);
    clock.advance(999);
    expect(at().currentIndex).toBe(0);
    clock.advance(1);
    expect(at().currentIndex).toBe(1);
  });

  it('recusa duração fora do intervalo e zero', () => {
    const { run, ids, engine } = session([8 * S]);
    for (const durationMs of [0, 499, 600_001, 1.5]) {
      expect(run({ type: 'setDuration', occurrenceId: ids[0]!, durationMs })).toEqual({ ok: false, reason: 'invalid-value' });
    }
    expect(engine.getView().current.durationMs).toBe(8 * S);
  });
});

describe('troca de modo', () => {
  it('manual → automático inicia o intervalo completo; automático → manual elimina o avanço', () => {
    const { clock, run, at } = session([8 * S, 12 * S], 'manual');
    run({ type: 'start' });
    clock.advance(30 * S);
    run({ type: 'setMode', mode: 'automatic' });
    clock.advance(7999);
    expect(at().currentIndex).toBe(0);
    run({ type: 'setMode', mode: 'manual' });
    clock.advance(60 * S);
    expect(at()).toMatchObject({ currentIndex: 0, mode: 'manual' });
    expect(clock.armed).toBe(0);
  });

  it('reiniciar ocorrência zera o intervalo e respeita a pausa; parar volta ao início', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(9 * S);
    run({ type: 'pause' });
    run({ type: 'restartOccurrence' });
    expect(at()).toMatchObject({ status: 'paused', currentIndex: 1, elapsedInSlideMs: 0 });
    run({ type: 'stop' });
    expect(at()).toMatchObject({ status: 'ready', currentIndex: 0 });
    expect(engine.getView().output.visualMode).toBe('black');
  });
});

describe('saída visual (AT-16)', () => {
  it('tela preta, ocultar letra e congelar não pausam nem reiniciam o relógio', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S, 10 * S]);
    run({ type: 'start' });
    clock.advance(3 * S);
    run({ type: 'setVisualMode', visualMode: 'black' });
    expect(engine.getView().output.visualMode).toBe('black');
    run({ type: 'setVisualMode', visualMode: 'lyricsHidden' });
    expect(engine.getView().output.visualMode).toBe('lyricsHidden');
    run({ type: 'setVisualMode', visualMode: 'normal' });
    run({ type: 'setFrozen', frozen: true });
    expect(at()).toMatchObject({ status: 'running', elapsedInSlideMs: 3 * S, frozenOutput: true });
    expect(engine.remainingMs()).toBe(5 * S);

    // Congelada: o relógio avança, o público continua vendo o slide 1.
    clock.advance(5 * S);
    expect(at().currentIndex).toBe(1);
    expect(engine.getView().live.index).toBe(1);
    expect(engine.getView().output.index).toBe(0);
    run({ type: 'setVisualMode', visualMode: 'black' });
    expect(engine.getView().output.visualMode).toBe('normal');
    run({ type: 'setFrozen', frozen: false });
    expect(engine.getView().output).toMatchObject({ index: 1, visualMode: 'black' });
    expect(engine.remainingMs()).toBe(12 * S);
  });
});

describe('ajustes ao vivo (AT-29, AT-30)', () => {
  it('A−/A+, fonte, tema, alinhamento e rotação não mexem no relógio', () => {
    const { clock, engine, run, at } = session([8 * S, 12 * S]);
    run({ type: 'start' });
    clock.advance(3 * S);
    const commands: OperatorCommand[] = [
      { type: 'stepFontSize', direction: 1, scope: 'occurrence' },
      { type: 'stepFontSize', direction: -1, scope: 'song' },
      { type: 'adjust', scope: 'occurrence', patch: { fontId: 'lato' } },
      { type: 'adjust', scope: 'song', patch: { themePresetId: 'violeta' } },
      { type: 'adjust', scope: 'song', patch: { textAlign: 'left', lineHeight: 1.4 } },
      { type: 'rotate' },
      { type: 'setRotation', rotation: 270 },
      { type: 'applyText', occurrenceId: at().currentOccurrenceId, text: 'Novo texto' },
      { type: 'undo' },
      { type: 'restoreAppearance' },
    ];
    for (const command of commands) expect(run(command), command.type).toEqual({ ok: true });
    expect(at()).toMatchObject({ status: 'running', currentIndex: 0, elapsedInSlideMs: 3 * S });
    expect(engine.remainingMs()).toBe(5 * S);
    clock.advance(5 * S);
    expect(at().currentIndex).toBe(1);
  });

  it('A+ anda de 4 em 4 px entre 32 e 160 e recusa passar do limite', () => {
    const { engine, run } = session([null]);
    expect(engine.getView().current.style.fontSizePx).toBe(96);
    run({ type: 'stepFontSize', direction: 1, scope: 'occurrence' });
    expect(engine.getView().current.style.fontSizePx).toBe(100);
    run({ type: 'adjust', scope: 'occurrence', patch: { fontSizePx: 160 } });
    expect(run({ type: 'stepFontSize', direction: 1, scope: 'occurrence' })).toEqual({ ok: false, reason: 'at-limit' });
    expect(run({ type: 'adjust', scope: 'occurrence', patch: { fontSizePx: 164 } })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(run({ type: 'adjust', scope: 'occurrence', patch: { fontSizePx: 28 } })).toEqual({ ok: false, reason: 'invalid-value' });
  });

  it('saída congelada: o ajuste fica no estado atual e só chega ao público ao liberar', () => {
    const { engine, run, at } = session([null, null], 'manual');
    run({ type: 'start' });
    run({ type: 'setFrozen', frozen: true });
    run({ type: 'applyText', occurrenceId: at().currentOccurrenceId, text: 'Texto revisado' });
    run({ type: 'adjust', scope: 'song', patch: { themePresetId: 'ambar' } });
    expect(engine.getView().current.text).toBe('Texto revisado');
    expect(engine.getView().output.slide.text).not.toBe('Texto revisado');
    expect(engine.getView().output.slide.style.palette.backgroundColor).toBe('#111827');
    run({ type: 'setFrozen', frozen: false });
    expect(engine.getView().output.slide).toMatchObject({ text: 'Texto revisado', style: { palette: { backgroundColor: '#211809', textColor: '#FDE68A' } } });
  });

  it('em tela preta o ajuste é aplicado e aparece ao restaurar', () => {
    const { engine, run } = session([null], 'manual');
    run({ type: 'start' });
    run({ type: 'setVisualMode', visualMode: 'black' });
    run({ type: 'adjust', scope: 'occurrence', patch: { fontId: 'roboto' } });
    expect(engine.getView().output).toMatchObject({ visualMode: 'black', slide: { fontId: 'roboto' } });
    run({ type: 'setVisualMode', visualMode: 'normal' });
    expect(engine.getView().output).toMatchObject({ visualMode: 'normal', slide: { fontId: 'roboto' } });
  });

  it('a base preparada nunca é alterada pelos ajustes', () => {
    const { engine, run, snapshot, at } = session([8 * S, null]);
    const before = JSON.stringify(snapshot);
    run({ type: 'adjust', scope: 'song', patch: { themePresetId: 'vinho', fontId: 'lato', fontSizePx: 120 } });
    run({ type: 'applyText', occurrenceId: at().currentOccurrenceId, text: 'Outro' });
    run({ type: 'setDuration', occurrenceId: at().currentOccurrenceId, durationMs: null });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(engine.getState().overridesRevision).toBe(3);
  });
});

describe('recuperação (AT-17)', () => {
  it('checkpoint de sessão em execução volta em pausa, na mesma posição e com os ajustes', () => {
    const first = session([8 * S, 12 * S, 10 * S]);
    first.run({ type: 'start' });
    first.clock.advance(8 * S + 4 * S);
    first.run({ type: 'adjust', scope: 'song', patch: { themePresetId: 'petroleo' } });
    first.run({ type: 'stepFontSize', direction: 1, scope: 'occurrence' });
    first.run({ type: 'setRotation', rotation: 90 });
    first.run({ type: 'setVisualMode', visualMode: 'lyricsHidden' });
    const checkpoint = JSON.parse(JSON.stringify(first.engine.checkpoint()));
    expect(checkpoint).not.toHaveProperty('anchor');

    // Outro processo: relógio com outra origem.
    const clock = new ManualClock(50);
    const engine = new PresentationEngine({ snapshot: first.snapshot, clock, sessionId: 'session-1', checkpoint });
    expect(engine.getState()).toMatchObject({ status: 'paused', mode: 'automatic', currentIndex: 1, elapsedInSlideMs: 4 * S, visualMode: 'lyricsHidden', overridesRevision: 2 });
    expect(engine.getView().rotation).toBe(90);
    expect(engine.getView().current).toMatchObject({ themePresetId: 'petroleo', style: { fontSizePx: 100 } });
    expect(clock.armed).toBe(0);
    clock.advance(3600 * S);
    expect(engine.getState()).toMatchObject({ status: 'paused', currentIndex: 1 });

    engine.execute({ type: 'resume' });
    expect(engine.remainingMs()).toBe(8 * S);
    // Desfazer continua funcionando depois de recuperar.
    engine.execute({ type: 'undo' });
    expect(engine.getView().rotation).toBe(90);
    expect(engine.getView().current.style.fontSizePx).toBe(96);
  });

  it('checkpoint de outro snapshot é ignorado; sessão pronta continua pronta', () => {
    const first = session([null, null], 'manual');
    first.run({ type: 'next' });
    const checkpoint = first.engine.checkpoint();
    const restored = new PresentationEngine({ snapshot: first.snapshot, clock: new ManualClock(), sessionId: 'session-1', checkpoint });
    expect(restored.getState()).toMatchObject({ status: 'ready', currentIndex: 1 });
    const other = new PresentationEngine({ snapshot: first.snapshot, clock: new ManualClock(), sessionId: 'session-1', checkpoint: { ...checkpoint, snapshotId: 'outro' } });
    expect(other.getState()).toMatchObject({ status: 'ready', currentIndex: 0 });
  });
});

describe('publicação de estado', () => {
  it('a sequência cresce a cada alteração e os ouvintes são avisados, inclusive no avanço automático', () => {
    const { clock, engine, run } = session([1 * S, 1 * S]);
    const seen: number[] = [];
    engine.subscribe(() => seen.push(engine.getState().sequenceNumber));
    run({ type: 'start' });
    clock.advance(1 * S);
    run({ type: 'setVisualMode', visualMode: 'black' });
    expect(seen).toEqual([1, 2, 3]);
    expect(run({ type: 'goTo', occurrenceId: 'inexistente' })).toEqual({ ok: false, reason: 'unknown-occurrence' });
    expect(seen).toHaveLength(3);
  });

  it('depois de descartado não agenda nem aceita comandos', () => {
    const { clock, engine, run } = session([1 * S, 1 * S]);
    run({ type: 'start' });
    engine.dispose();
    expect(clock.armed).toBe(0);
    expect(run({ type: 'next' })).toEqual({ ok: false, reason: 'invalid-state' });
  });
});
