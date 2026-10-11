import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIO_CHUNK_BYTES, ReceiverRelay } from './relay';
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
  it('a leitura em espera do projetor responde na hora em que o slide muda', async () => {
    const relay = new ReceiverRelay(); const screen = relay.create(); const phone = relay.pair(screen.code);
    const { version } = relay.read(screen.id, screen.token);
    let answered = false;
    const pending = relay.wait(screen.id, screen.token, version, 60_000).then(data => { answered = true; return data; });
    await Promise.resolve(); expect(answered).toBe(false);
    // Enquanto espera, o projetor conta como presente para o celular.
    expect(relay.read(phone.id, phone.token).peerOnline).toBe(true);
    const snapshot = frame(); relay.publish(phone.id, phone.token, snapshot);
    expect((await pending).message).toEqual(snapshot);
    // Versão desatualizada responde sem esperar.
    expect((await relay.wait(screen.id, screen.token, version, 60_000)).message).toEqual(snapshot);
  });
  it('oferece código novo quando o celular some e deixa outro celular assumir', () => {
    let now = 1_000_000; const relay = new ReceiverRelay(() => now); const screen = relay.create(); const phone = relay.pair(screen.code);
    relay.publish(phone.id, phone.token, frame());
    expect(relay.read(screen.id, screen.token).code).toBeNull();
    now += 21_000; const offered = relay.read(screen.id, screen.token).code;
    expect(offered).toMatch(/^\d{4}$/);
    // O celular voltou antes de alguém usar o código: ele deixa de valer.
    relay.read(phone.id, phone.token); expect(relay.read(screen.id, screen.token).code).toBeNull();
    expect(() => relay.pair(offered!)).toThrow('Código inválido');
    now += 21_000; const other = relay.pair(relay.read(screen.id, screen.token).code!);
    expect(() => relay.read(phone.id, phone.token)).toThrow('Conexão encerrada');
    expect(relay.read(screen.id, screen.token)).toMatchObject({ paired: true, message: null });
    expect(relay.read(other.id, other.token).paired).toBe(true);
  });
  it('código de sala sem celular é renovado antes de expirar', () => {
    let now = 1_000_000; const relay = new ReceiverRelay(() => now); const screen = relay.create();
    now += 500_000; expect(relay.read(screen.id, screen.token).code).toBe(screen.code);
    now += 50_000; const renewed = relay.read(screen.id, screen.token).code!;
    expect(renewed).not.toBe(screen.code); expect(() => relay.pair(screen.code)).toThrow('Código inválido');
    expect(relay.pair(renewed).id).toBe(screen.id);
  });
  it('leva a faixa em partes ao projetor, em qualquer ordem, e a posição com a idade no servidor', () => {
    let now = 1_000_000; const relay = new ReceiverRelay(() => now); const screen = relay.create(); const phone = relay.pair(screen.code);
    const content = new Uint8Array(AUDIO_CHUNK_BYTES + 5).map((_, index) => index % 251);
    const sha256 = createHash('sha256').update(content).digest('hex'); const state = { sha256, playing: true, positionMs: 5000, volume: 0.8 };
    expect(relay.setAudio(phone.id, phone.token, state, 100)).toMatchObject({ file: null, audioStatus: null });
    expect(relay.read(screen.id, screen.token).audio).toMatchObject({ sha256, playing: true, positionMs: 5000, ageMs: 100, available: false });
    const file = { sha256, mime: 'audio/mpeg', total: content.byteLength };
    const tail = content.slice(AUDIO_CHUNK_BYTES); const head = content.slice(0, AUDIO_CHUNK_BYTES);
    expect(relay.putAudio(phone.id, phone.token, { ...file, offset: AUDIO_CHUNK_BYTES }, tail)).toEqual({ received: 5, total: content.byteLength, missing: [0] });
    // Parte repetida não é gravada de novo; tamanho ou posição errados são recusados.
    expect(relay.putAudio(phone.id, phone.token, { ...file, offset: AUDIO_CHUNK_BYTES }, tail).received).toBe(5);
    expect(() => relay.putAudio(phone.id, phone.token, { ...file, offset: 3 }, tail)).toThrow('Áudio inválido');
    expect(() => relay.getAudio(screen.id, screen.token, sha256)).toThrow('Áudio indisponível');
    expect(relay.putAudio(phone.id, phone.token, { ...file, offset: 0 }, head).missing).toEqual([]);
    now += 250;
    expect(relay.read(screen.id, screen.token).audio).toMatchObject({ available: true, ageMs: 350 });
    expect(Buffer.compare(relay.getAudio(screen.id, screen.token, sha256).bytes, Buffer.from(content))).toBe(0);
    expect(() => relay.putAudio(screen.id, screen.token, { ...file, offset: 0 }, head)).toThrow('Somente o controle');
    relay.setAudioStatus(screen.id, screen.token, sha256, 'ready');
    expect(relay.setAudio(phone.id, phone.token, state)).toMatchObject({ peerOnline: true, audioStatus: { sha256, status: 'ready' }, file: { received: content.byteLength, missing: [] } });
    relay.setAudio(phone.id, phone.token, null); expect(relay.read(screen.id, screen.token).audio).toBeNull();
    // Outro pareamento, mesmo louvor: a faixa já está no servidor, nada é enviado de novo.
    const other = relay.create(); const otherPhone = relay.pair(other.code);
    expect(relay.setAudio(otherPhone.id, otherPhone.token, state).file).toMatchObject({ missing: [] });
    expect(relay.read(other.id, other.token).audio).toMatchObject({ available: true });
  });
  it('com pasta de faixas, o que foi enviado sobrevive ao reinício do servidor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lv-relay-'));
    try {
      const content = new Uint8Array(1000).map((_, index) => index % 97);
      const sha256 = createHash('sha256').update(content).digest('hex'); const state = { sha256, playing: false, positionMs: 0, volume: 1 };
      const first = new ReceiverRelay(undefined, dir); const screen = first.create(); const phone = first.pair(screen.code);
      first.setAudio(phone.id, phone.token, state);
      expect(first.putAudio(phone.id, phone.token, { sha256, mime: 'audio/mpeg', total: 1000, offset: 0 }, content).missing).toEqual([]);
      expect(Buffer.compare(first.getAudio(screen.id, screen.token, sha256).bytes, Buffer.from(content))).toBe(0);
      // Outro processo, mesma pasta: nada a enviar, e o projetor baixa direto.
      const second = new ReceiverRelay(undefined, dir); const again = second.create(); const againPhone = second.pair(again.code);
      expect(second.setAudio(againPhone.id, againPhone.token, state).file).toEqual({ received: 1000, total: 1000, missing: [] });
      expect(second.read(again.id, again.token).audio).toMatchObject({ available: true });
      expect(second.getAudio(again.id, again.token, sha256)).toMatchObject({ mime: 'audio/mpeg' });
      expect(Buffer.compare(second.getAudio(again.id, again.token, sha256).bytes, Buffer.from(content))).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('recusa uma faixa cujo conteúdo não confere com o hash', () => {
    const relay = new ReceiverRelay(); const screen = relay.create(); const phone = relay.pair(screen.code);
    expect(() => relay.putAudio(phone.id, phone.token, { sha256: 'a'.repeat(64), mime: 'audio/mpeg', total: 3, offset: 0 }, new Uint8Array([1, 2, 3]))).toThrow('diferente do original');
  });
  it('limita tentativas de adivinhar códigos', () => {
    const relay = new ReceiverRelay(); for (let i = 0; i < 10; i++) relay.limit('client');
    expect(() => relay.limit('client')).toThrow('Muitas tentativas');
  });
});
