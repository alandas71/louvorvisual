import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { PresentationEngine } from './engine';
import { CONNECTION_TIMEOUT_MS, ControllerLink, isProjectionCommandAllowed, ProjectionReceiver, shortcutCommand, type ChannelMessage, type VisualState } from './protocol';
import { timedSong } from './testing';

function setup() {
  const { snapshot } = timedSong([null, null, null]);
  const engine = new PresentationEngine({ snapshot, clock: new ManualClock(), sessionId: 'sessao', mode: 'manual' });
  const visual = (): VisualState => {
    const view = engine.getView();
    return { sequenceNumber: view.state.sequenceNumber, frame: view.output, rotation: view.rotation, controls: view.controls };
  };
  const link = new ControllerLink('sessao', 10, { title: 'Em União', artist: null });
  const receiver = new ProjectionReceiver('sessao', 'janela-1');
  return { engine, visual, link, receiver };
}

describe('janela pública', () => {
  it('pede o estado, recebe o snapshot e confirma a sequência aplicada', () => {
    const { engine, visual, link, receiver } = setup();
    expect(receiver.getState().status).toBe('waiting');
    expect(link.receive(receiver.hello(), 0)).toEqual({ hello: true, command: null });
    const { changed, reply } = receiver.receive(link.snapshotMessage(visual()), 0);
    expect(changed).toBe(true);
    expect(reply).toEqual([{ type: 'STATE_ACK', sessionId: 'sessao', generation: 10, windowId: 'janela-1', sequenceNumber: 0, armed: false, fontMissing: false }]);
    expect(receiver.getState()).toMatchObject({ status: 'live', info: { title: 'Em União' } });

    engine.execute({ type: 'start' });
    receiver.armed = true;
    const next = receiver.receive(link.stateMessage(visual()), 10);
    expect(next.reply[0]).toMatchObject({ type: 'STATE_ACK', sequenceNumber: 1, armed: true });
    link.receive(next.reply[0], 10);
    expect(link.status(10)).toEqual({ connection: 'connected', windows: 1, armed: true, fontMissing: false, confirmedSequence: 1 });

    // Fonte que falhou na janela pública chega ao operador pela confirmação.
    receiver.fontMissing = true;
    link.receive(receiver.acknowledge(), 11);
    expect(link.status(11).fontMissing).toBe(true);
  });

  it('nada do que vai para a saída carrega as notas privadas do operador', () => {
    const { snapshot } = timedSong([null, 8000]);
    const withNotes = { ...snapshot, song: { ...snapshot.song, notes: 'Entrar só depois da oração — segredo do operador' } };
    const engine = new PresentationEngine({ snapshot: withNotes, clock: new ManualClock(), sessionId: 'sessao' });
    const link = new ControllerLink('sessao', 1, { title: withNotes.song.title, artist: withNotes.song.artist });
    engine.execute({ type: 'start' });
    const view = engine.getView();
    const state = { sequenceNumber: view.state.sequenceNumber, frame: view.output, rotation: view.rotation, controls: view.controls };
    for (const message of [link.snapshotMessage(state), link.stateMessage(state), link.heartbeatMessage(1), link.endedMessage()]) {
      expect(JSON.stringify(message)).not.toContain('segredo');
    }
    expect(withNotes.song.notes).toContain('segredo');
  });

  it('ignora outra sessão, geração antiga e sequência atrasada', () => {
    const { engine, visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 0);
    const old = visual();
    engine.execute({ type: 'start' });
    engine.execute({ type: 'next' });
    receiver.receive(link.stateMessage(visual()), 1);
    expect(receiver.getState().visual?.frame.index).toBe(1);

    // Mensagem intermediária atrasada não desfaz a troca recente.
    expect(receiver.receive(link.stateMessage(old), 2)).toEqual({ changed: false, reply: [] });
    expect(receiver.getState().visual?.frame.index).toBe(1);

    const stale = new ControllerLink('sessao', 9, { title: 'x', artist: null });
    expect(receiver.receive(stale.snapshotMessage(old), 3).changed).toBe(false);
    const foreign = new ControllerLink('outra', 99, { title: 'x', artist: null });
    expect(receiver.receive(foreign.snapshotMessage(old), 3).changed).toBe(false);
    expect(receiver.receive({ nada: true }, 3).changed).toBe(false);
    expect(receiver.getState()).toMatchObject({ generation: 10, visual: { frame: { index: 1 } } });
  });

  it('estado completo repetido pode ser reenviado sem efeito colateral', () => {
    const { visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 0);
    const again = receiver.receive(link.snapshotMessage(visual()), 1);
    expect(again.changed).toBe(false);
    expect(again.reply).toHaveLength(1);
  });

  it('controlador novo (página recarregada) assume com geração maior, mesmo com sequência menor', () => {
    const { engine, visual, link, receiver } = setup();
    engine.execute({ type: 'start' });
    engine.execute({ type: 'next' });
    receiver.receive(link.snapshotMessage(visual()), 0);
    const recovered = new ControllerLink('sessao', 11, { title: 'Em União', artist: null });
    // Estado solto de quem a janela ainda não conhece: pede o snapshot completo.
    expect(receiver.receive(recovered.stateMessage({ ...visual(), sequenceNumber: 0 }), 1).reply).toEqual([receiver.hello()]);
    expect(receiver.receive(recovered.snapshotMessage({ ...visual(), sequenceNumber: 0 }), 2).changed).toBe(true);
    expect(receiver.getState()).toMatchObject({ generation: 11, visual: { sequenceNumber: 0 } });
    // O antigo não manda mais.
    expect(receiver.receive(link.stateMessage({ ...visual(), sequenceNumber: 50 }), 3).changed).toBe(false);
  });

  it('heartbeat mostra que perdeu uma troca e a janela pede o estado completo', () => {
    const { visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 0);
    expect(receiver.receive(link.heartbeatMessage(0), 1).reply).toEqual([]);
    expect(receiver.receive(link.heartbeatMessage(4), 2).reply).toEqual([receiver.hello()]);
  });

  it('sem controlador por três segundos mantém a imagem e para de enviar comandos', () => {
    const { visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 1000);
    expect(receiver.controllerLost(1000 + CONNECTION_TIMEOUT_MS)).toBe(false);
    expect(receiver.command({ type: 'next' }, 2000)).toMatchObject({ type: 'OPERATOR_COMMAND', commandId: 'janela-1:1' });
    expect(receiver.controllerLost(1001 + CONNECTION_TIMEOUT_MS)).toBe(true);
    expect(receiver.command({ type: 'next' }, 1001 + CONNECTION_TIMEOUT_MS)).toBeNull();
    expect(receiver.getState().visual).not.toBeNull();
    receiver.receive(link.heartbeatMessage(0), 9000);
    expect(receiver.controllerLost(9001)).toBe(false);
  });

  it('sessão encerrada volta à espera sem imagem', () => {
    const { visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 0);
    expect(receiver.receive(link.endedMessage(), 1).changed).toBe(true);
    expect(receiver.getState()).toMatchObject({ status: 'ended', visual: null });
    expect(receiver.command({ type: 'next' }, 1)).toBeNull();
    expect(receiver.heartbeat()).toBeNull();
  });
});

describe('controlador', () => {
  it('executa uma vez cada comando da saída e descarta repetição, outra geração e ação não permitida', () => {
    const { visual, link, receiver } = setup();
    receiver.receive(link.snapshotMessage(visual()), 0);
    const message = receiver.command({ type: 'next' }, 0) as ChannelMessage;
    expect(link.receive(message, 0).command).toEqual({ type: 'next' });
    expect(link.receive(message, 0).command).toBeNull();
    expect(link.receive({ ...message, commandId: 'x', generation: 9 }, 0).command).toBeNull();
    expect(link.receive({ ...message, commandId: 'y', sessionId: 'outra' }, 0).command).toBeNull();
    for (const command of [{ type: 'stop' }, { type: 'applyText', occurrenceId: 'a', text: 'b' }, { type: 'start' }, { type: 'apagarTudo' }, null]) {
      expect(isProjectionCommandAllowed(command), JSON.stringify(command)).toBe(false);
      expect(link.receive({ ...message, commandId: `z-${JSON.stringify(command)}`, command }, 0).command).toBeNull();
    }
    expect(receiver.command({ type: 'stop' }, 0)).toBeNull();
  });

  it('avisa quando as confirmações param por três segundos e volta ao reconectar', () => {
    const { visual, link, receiver } = setup();
    expect(link.status(0).connection).toBe('none');
    link.receive(receiver.hello(), 0);
    const ack = receiver.receive(link.snapshotMessage(visual()), 0).reply[0];
    link.receive(ack, 100);
    expect(link.status(100 + CONNECTION_TIMEOUT_MS).connection).toBe('connected');
    expect(link.status(101 + CONNECTION_TIMEOUT_MS)).toEqual({ connection: 'lost', windows: 0, armed: false, fontMissing: false, confirmedSequence: null });
    link.receive(receiver.heartbeat(), 9000);
    expect(link.status(9001)).toMatchObject({ connection: 'connected', windows: 1 });
  });
});

describe('atalhos', () => {
  const controls = { status: 'running', capabilities: { timerIndicator: false, countdown: false, transport: false }, visualMode: 'normal', frozen: false } as const;

  it('mapeia as teclas do planejamento', () => {
    expect(shortcutCommand({ key: 'ArrowRight' }, controls)).toEqual({ type: 'next' });
    expect(shortcutCommand({ key: 'PageDown' }, controls)).toEqual({ type: 'next' });
    expect(shortcutCommand({ key: 'ArrowLeft' }, controls)).toEqual({ type: 'previous' });
    expect(shortcutCommand({ key: 'PageUp' }, controls)).toEqual({ type: 'previous' });
    expect(shortcutCommand({ key: 'Home' }, controls)).toEqual({ type: 'first' });
    expect(shortcutCommand({ key: 'b' }, controls)).toEqual({ type: 'setVisualMode', visualMode: 'black' });
    expect(shortcutCommand({ key: 'B' }, { ...controls, visualMode: 'black' })).toEqual({ type: 'setVisualMode', visualMode: 'normal' });
    expect(shortcutCommand({ key: 'l' }, controls)).toEqual({ type: 'setVisualMode', visualMode: 'lyricsHidden' });
    expect(shortcutCommand({ key: 'c' }, controls)).toEqual({ type: 'setFrozen', frozen: true });
    expect(shortcutCommand({ key: 'c' }, { ...controls, frozen: true })).toEqual({ type: 'setFrozen', frozen: false });
    expect(shortcutCommand({ key: 'Escape' }, controls)).toBeNull();
  });

  it('Espaço só age com transporte disponível ou para iniciar; modificadores são ignorados', () => {
    expect(shortcutCommand({ key: ' ' }, controls)).toBeNull();
    expect(shortcutCommand({ key: ' ' }, { ...controls, status: 'ready' })).toEqual({ type: 'toggle' });
    expect(shortcutCommand({ key: ' ' }, { ...controls, capabilities: { ...controls.capabilities, transport: true } })).toEqual({ type: 'toggle' });
    expect(shortcutCommand({ key: 'ArrowRight', ctrlKey: true }, controls)).toBeNull();
    expect(shortcutCommand({ key: 'b', metaKey: true }, controls)).toBeNull();
    expect(shortcutCommand({ key: 'l', altKey: true }, controls)).toBeNull();
  });
});

describe('encerramento', () => {
  it('pedido de estado que cruza com o fim não devolve o slide à tela', () => {
    const { visual, link, receiver } = setup();
    link.receive(receiver.hello(), 0);
    // O controlador responde a um pedido e, logo depois, anuncia o fim.
    const lateSnapshot = link.snapshotMessage(visual());
    const lateState = link.stateMessage(visual());
    receiver.receive(lateSnapshot, 0);
    receiver.receive(link.endedMessage(), 1);
    expect(receiver.getState().status).toBe('ended');

    // Respostas atrasadas do mesmo controlador são ignoradas: a saída continua preta.
    expect(receiver.receive(lateSnapshot, 2)).toEqual({ changed: false, reply: [] });
    expect(receiver.receive(lateState, 2)).toEqual({ changed: false, reply: [] });
    expect(receiver.getState()).toMatchObject({ status: 'ended', visual: null });
    // E o controlador encerrado não atende mais pedidos nem comandos.
    expect(link.receive(receiver.hello(), 3)).toEqual({ hello: false, command: null });

    // Uma sessão recuperada por um controlador mais novo reabre a saída.
    const newer = new ControllerLink('sessao', 11, { title: 'Em União', artist: null });
    expect(receiver.receive(newer.snapshotMessage(visual()), 4).changed).toBe(true);
    expect(receiver.getState()).toMatchObject({ status: 'live', generation: 11 });
  });

  it('próximo louvor: a saída fica preta e é avisada de qual sessão esperar', () => {
    const { visual, link, receiver } = setup();
    link.receive(receiver.hello(), 0);
    receiver.receive(link.snapshotMessage(visual()), 0);
    const result = receiver.receive(link.handoffMessage('sessao-seguinte'), 1);
    expect(result).toMatchObject({ changed: true, handoffTo: 'sessao-seguinte' });
    expect(receiver.getState()).toMatchObject({ status: 'ended', visual: null });
    // Um fim comum não indica sessão seguinte; outra sessão não comanda esta janela.
    const other = setup();
    other.link.receive(other.receiver.hello(), 0);
    other.receiver.receive(other.link.snapshotMessage(other.visual()), 0);
    expect(other.receiver.receive(other.link.endedMessage(), 1).handoffTo).toBeUndefined();
    const stranger = new ControllerLink('outra-sessao', 99, { title: 'x', artist: null });
    expect(new ProjectionReceiver('sessao', 'janela-2').receive(stranger.handoffMessage('qualquer'), 0)).toEqual({ changed: false, reply: [] });
  });
});
