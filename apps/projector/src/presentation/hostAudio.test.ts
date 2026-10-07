import { BRIDGE_VERSION, type AudioStateEvent, type HostPort, type HostRequest } from '@louvorvisual/contracts';
import { AudioPlayBlockedError, AudioSeekError, type AudioTransportEvent } from '@louvorvisual/presentation';
import { describe, expect, it } from 'vitest';
import { HostClient } from '../host/client';
import { HostAudioTransport } from './hostAudio';

/** Host de teste: guarda os pedidos e responde quando o teste manda, como um player real. */
function harness(durationMs = 60_000) {
  const sent: HostRequest[] = [];
  const port: HostPort = { postMessage: (message) => void sent.push(JSON.parse(message) as HostRequest), onmessage: null };
  const deliver = (message: unknown) => port.onmessage?.({ data: JSON.stringify(message) });
  const client = new HostClient(port);
  let now = 0;
  const transport = new HostAudioTransport(client, { now: () => now }, durationMs);
  const events: AudioTransportEvent['type'][] = [];
  transport.subscribe((event) => events.push(event.type));
  const last = (method: string) => sent.filter((request) => request.method === method).at(-1)!;
  return {
    transport,
    sent,
    events,
    advance: (ms: number) => (now += ms),
    reply: (method: string, result: unknown = {}) => deliver({ v: BRIDGE_VERSION, kind: 'response', id: last(method).id, ok: true, result }),
    replyTo: (id: number, result: unknown) => deliver({ v: BRIDGE_VERSION, kind: 'response', id, ok: true, result }),
    fail: (method: string, code: string) => deliver({ v: BRIDGE_VERSION, kind: 'error', id: last(method).id, error: { code, message: '' } }),
    state: (payload: AudioStateEvent) => deliver({ v: BRIDGE_VERSION, kind: 'event', event: 'audio.state', payload }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('player do host visto pelo motor', () => {
  it('a posição só anda depois de o host confirmar que está tocando, e é projetada entre os avisos', async () => {
    const h = harness();
    const playing = h.transport.play();
    expect(h.transport.isPlaying()).toBe(true);
    h.advance(500);
    // Pedido feito, player ainda não confirmou: a posição não é inventada.
    expect(h.transport.positionMs()).toBe(0);
    h.reply('audio.play');
    await playing;
    h.state({ type: 'playing', positionMs: 0 });
    h.advance(1000);
    expect(h.transport.positionMs()).toBe(1000);
    h.state({ type: 'time', positionMs: 1040 });
    expect(h.transport.positionMs()).toBe(1040);
    h.advance(200);
    expect(h.transport.positionMs()).toBe(1240);
    expect(h.events).toEqual(['playing', 'time']);
  });

  it('pausa pedida aqui é publicada na hora, uma vez; o eco do host não vira uma segunda pausa', async () => {
    const h = harness();
    void h.transport.play();
    h.reply('audio.play');
    h.state({ type: 'playing', positionMs: 0 });
    h.advance(2000);
    h.transport.pause();
    expect(h.transport.isPlaying()).toBe(false);
    expect(h.transport.positionMs()).toBe(2000);
    h.advance(5000);
    expect(h.transport.positionMs()).toBe(2000);
    h.reply('audio.pause', { positionMs: 2010 });
    h.state({ type: 'paused', positionMs: 2010, external: false });
    await flush();
    expect(h.transport.positionMs()).toBe(2010);
    expect(h.events).toEqual(['playing', 'paused']);
  });

  it('pausar e retomar depressa: o eco atrasado da pausa não derruba a retomada', async () => {
    const h = harness();
    void h.transport.play();
    h.reply('audio.play');
    h.state({ type: 'playing', positionMs: 0 });
    h.transport.pause();
    void h.transport.play();
    // Chega agora o eco da pausa antiga, com a faixa já pedida de novo.
    h.state({ type: 'paused', positionMs: 0, external: false });
    expect(h.transport.isPlaying()).toBe(true);
    h.reply('audio.play');
    h.state({ type: 'playing', positionMs: 0 });
    expect(h.events).toEqual(['playing', 'paused', 'playing']);
  });

  it('pausa de fora (foco de áudio, tecla de mídia) chega ao motor', () => {
    const h = harness();
    void h.transport.play();
    h.reply('audio.play');
    h.state({ type: 'playing', positionMs: 0 });
    h.advance(3000);
    h.state({ type: 'paused', positionMs: 2950, external: true });
    expect(h.transport.isPlaying()).toBe(false);
    expect(h.transport.positionMs()).toBe(2950);
    expect(h.events).toEqual(['playing', 'paused']);
  });

  it('play recusado pelo sistema vira bloqueio; outra falha é repassada', async () => {
    const h = harness();
    const blocked = h.transport.play();
    h.fail('audio.play', 'blocked');
    await expect(blocked).rejects.toBeInstanceOf(AudioPlayBlockedError);
    expect(h.transport.isPlaying()).toBe(false);
    const broken = h.transport.play();
    h.fail('audio.play', 'unavailable');
    await expect(broken).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('seek: vale a posição confirmada pelo host; um pedido novo torna o anterior sem efeito', async () => {
    const h = harness();
    const first = h.transport.seek(10_000);
    const firstId = h.sent.at(-1)!.id;
    const second = h.transport.seek(20_000);
    h.replyTo(firstId, { positionMs: 10_000 });
    await expect(first).rejects.toMatchObject({ reason: 'superseded' });
    h.reply('audio.seek', { positionMs: 19_980 });
    await expect(second).resolves.toBe(19_980);
    expect(h.transport.positionMs()).toBe(19_980);
    const failed = h.transport.seek(5);
    h.fail('audio.seek', 'failed');
    await expect(failed).rejects.toBeInstanceOf(AudioSeekError);
  });

  it('parada inesperada congela a posição; fim e erro encerram a reprodução; encerrar solta o player', async () => {
    const h = harness(5000);
    void h.transport.play();
    h.reply('audio.play');
    h.state({ type: 'playing', positionMs: 0 });
    h.advance(1000);
    h.state({ type: 'waiting', positionMs: 900 });
    h.advance(4000);
    expect(h.transport.positionMs()).toBe(900);
    h.state({ type: 'playing', positionMs: 900 });
    h.advance(10_000);
    // Nunca passa da duração, mesmo sem aviso do host.
    expect(h.transport.positionMs()).toBe(5000);
    h.state({ type: 'ended', positionMs: 5000 });
    expect(h.transport.isPlaying()).toBe(false);
    expect(h.events).toEqual(['playing', 'waiting', 'playing', 'ended']);
    h.transport.dispose();
    expect(h.sent.at(-1)!.method).toBe('audio.release');
    h.state({ type: 'error', positionMs: 0, reason: 'unknown' });
    expect(h.events).toHaveLength(4);
  });
});
