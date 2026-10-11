import { describe, expect, it } from 'vitest';
import { ReceiverRelay } from './relay';
import { PresentationEngine, ControllerLink } from '@louvorvisual/presentation';
import { timedSong } from '../../../../packages/presentation/src/testing';
function frame(sessionId = 'session-1') {
  const engine = new PresentationEngine({ snapshot: timedSong([null, null]).snapshot, sessionId, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} } });
  const view = engine.getView();
  return new ControllerLink(sessionId, 1, { title: 'Em União', artist: null }).snapshotMessage({ sequenceNumber: view.state.sequenceNumber, frame: view.output, rotation: view.rotation, controls: view.controls });
}
describe('receptor do PWA', () => {
  it('conecta uma única vez com código, sem expor os tokens na leitura', () => {
    const relay = new ReceiverRelay(); const screen = relay.create(); const phone = relay.pair(screen.code);
    expect(phone.id).toBe(screen.id); expect(phone.token).not.toBe(screen.token);
    expect(() => relay.pair(screen.code)).toThrow('Código inválido');
    expect(relay.read(screen.id, screen.token)).toMatchObject({ paired: true });
    expect(JSON.stringify(relay.read(screen.id, screen.token))).not.toContain(phone.token);
    expect(() => relay.read(screen.id, 'wrong')).toThrow('Conexão encerrada');
  });
  it('reencontra o slide completo e envia confirmação para um celular separado', () => {
    const relay = new ReceiverRelay(); const screen = relay.create(); const phone = relay.pair(screen.code);
    const snapshot = frame(); relay.publish(phone.id, phone.token, snapshot);
    expect(relay.read(screen.id, screen.token).message).toEqual(snapshot);
    if (snapshot.type !== 'SESSION_SNAPSHOT') throw new Error();
    relay.publish(phone.id, phone.token, { type: 'VISUAL_STATE', sessionId: snapshot.sessionId, generation: 1, state: { ...snapshot.state, sequenceNumber: 2, rotation: 90 } });
    expect(relay.read(screen.id, screen.token).message).toMatchObject({ type: 'SESSION_SNAPSHOT', info: snapshot.info, state: { sequenceNumber: 2, rotation: 90 } });
    const ack = { type: 'STATE_ACK', sessionId: snapshot.sessionId, generation: 1, windowId: screen.id, sequenceNumber: 2, armed: true, fontMissing: false } as const;
    relay.publish(screen.id, screen.token, ack); expect(relay.read(phone.id, phone.token).message).toEqual(ack);
    expect(() => relay.publish(screen.id, screen.token, snapshot)).toThrow('Confirmação inválida');
    relay.publish(phone.id, phone.token, { type: 'SESSION_ENDED', sessionId: snapshot.sessionId, generation: 1 });
    expect(relay.read(screen.id, screen.token).message?.type).toBe('SESSION_ENDED');
    relay.close(screen.id, screen.token); expect(() => relay.read(phone.id, phone.token)).toThrow('Conexão encerrada');
  });
  it('não confunde os dispositivos online e expira pareamentos abandonados', () => {
    let now = 1_000_000; const relay = new ReceiverRelay(() => now); const screen = relay.create(); const phone = relay.pair(screen.code);
    relay.read(phone.id, phone.token); now += 4000;
    expect(relay.read(screen.id, screen.token).peerOnline).toBe(false);
    expect(relay.read(phone.id, phone.token).peerOnline).toBe(true);
    now += 121_000; expect(() => relay.read(phone.id, phone.token)).toThrow('Conexão encerrada');
    const waiting = relay.create(); now += 601_000; expect(() => relay.pair(waiting.code)).toThrow('Código inválido');
  });
  it('ignora estados antigos e mantém o fim de uma sessão definitivo', () => {
    const relay = new ReceiverRelay(); const screen = relay.create(); const phone = relay.pair(screen.code);
    const first = frame(); if (first.type !== 'SESSION_SNAPSHOT') throw new Error();
    relay.publish(phone.id, phone.token, first);
    relay.publish(phone.id, phone.token, { type: 'SESSION_ENDED', sessionId: first.sessionId, generation: 1 });
    relay.publish(phone.id, phone.token, first);
    expect(relay.read(screen.id, screen.token).message?.type).toBe('SESSION_ENDED');
    const next = { ...first, sessionId: 'session-2', generation: 2 };
    relay.publish(phone.id, phone.token, next); relay.publish(phone.id, phone.token, first);
    expect(relay.read(screen.id, screen.token).message).toEqual(next);
  });
  it('limita tentativas de adivinhar códigos', () => {
    const relay = new ReceiverRelay(); for (let i = 0; i < 10; i++) relay.limit('client');
    expect(() => relay.limit('client')).toThrow('Muitas tentativas');
  });
});
