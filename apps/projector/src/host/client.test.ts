import { BRIDGE_VERSION, type HostPort, type HostRequest } from '@louvorvisual/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClient, HostError } from './client';

function fakePort() {
  const sent: HostRequest[] = [];
  const port: HostPort = { postMessage: (message) => void sent.push(JSON.parse(message) as HostRequest), onmessage: null };
  const deliver = (message: unknown) => port.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  const reply = (id: number, result: unknown) => deliver({ v: BRIDGE_VERSION, kind: 'response', id, ok: true, result });
  return { port, sent, deliver, reply };
}

const INFO = { bridgeVersion: 1, host: 'mock', appVersion: '0', fontPackVersion: '1' };
const key = (seq: number) => ({ v: 1, kind: 'event', event: 'remote.key', payload: { epoch: 'a', seq, key: 'right', action: 'down', repeat: 0 } });

afterEach(() => vi.useRealTimers());

describe('cliente da ponte', () => {
  it('cada pedido leva um ID próprio e recebe a resposta que é dele, mesmo fora de ordem', async () => {
    const { port, sent, reply } = fakePort();
    const client = new HostClient(port);
    const first = client.request('host.info', {});
    const second = client.request('prefs.get', {});
    expect(sent.map((request) => [request.v, request.kind, request.id, request.method])).toEqual([
      [1, 'request', 1, 'host.info'],
      [1, 'request', 2, 'prefs.get'],
    ]);
    reply(2, { prefs: { rotation: 90, safeAreaPercent: 0, recentSetlistId: null } });
    reply(1, INFO);
    expect((await second).prefs.rotation).toBe(90);
    expect((await first).host).toBe('mock');
  });

  it('resposta repetida, sem pedido ou ilegível é descartada sem efeito', async () => {
    const { port, reply, deliver } = fakePort();
    const client = new HostClient(port);
    const pending = client.request('host.info', {});
    reply(1, INFO);
    reply(1, { ...INFO, appVersion: 'outra' });
    reply(99, INFO);
    deliver('isto não é JSON');
    deliver({ v: 1, kind: 'eval', code: 'x' });
    deliver({ v: 2, kind: 'response', id: 1, ok: true, result: INFO });
    expect((await pending).appVersion).toBe('0');
    expect(client.stats).toMatchObject({ responses: 1, dropped: 5 });
  });

  it('resultado fora do contrato vira erro, não dado', async () => {
    const { port, reply } = fakePort();
    const client = new HostClient(port);
    const pending = client.request('library.listSongs', { cursor: null, limit: 20 });
    reply(1, { items: [{ title: 'sem id' }], nextCursor: null });
    await expect(pending).rejects.toMatchObject({ code: 'invalid-response', method: 'library.listSongs' });
  });

  it('parâmetros fora do contrato não saem do bundle', async () => {
    const { port, sent } = fakePort();
    const client = new HostClient(port);
    await expect(client.request('library.listSongs', { cursor: null, limit: 500 })).rejects.toBeInstanceOf(HostError);
    await expect(client.request('account.signIn', { password: 'x' } as never)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(sent).toHaveLength(0);
  });

  it('erro do host chega com o código; sem resposta, o pedido vence o prazo e a resposta atrasada é ignorada', async () => {
    vi.useFakeTimers();
    const { port, deliver, reply } = fakePort();
    const client = new HostClient(port, { timeoutMs: 1000 });
    const missing = client.request('library.getSetlist', { setlistId: '00000000-0000-4000-8000-000000000001' });
    deliver({ v: 1, kind: 'error', id: 1, error: { code: 'not-found', message: '' } });
    await expect(missing).rejects.toMatchObject({ code: 'not-found' });

    const slow = client.request('host.info', {});
    const rejected = expect(slow).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(1001);
    await rejected;
    reply(2, INFO);
    expect(client.stats.dropped).toBe(1);
  });

  it('eventos: só os do contrato chegam a quem escuta, uma vez por mensagem', () => {
    const { port, deliver } = fakePort();
    const client = new HostClient(port);
    const seen: number[] = [];
    const off = client.on('remote.key', (event) => seen.push(event.seq));
    deliver(key(1));
    deliver({ ...key(2), payload: { epoch: 'a', seq: 2, key: 'home', action: 'down', repeat: 0 } });
    deliver({ v: 1, kind: 'event', event: 'remote.pointer', payload: {} });
    deliver(key(3));
    off();
    deliver(key(4));
    expect(seen).toEqual([1, 3]);
    // A quarta tecla é válida e contada; só não havia mais ninguém escutando.
    expect(client.stats).toMatchObject({ events: 3, dropped: 2 });
  });

  it('fechar rejeita o que estava pendente e para de entregar', async () => {
    const { port, reply } = fakePort();
    const client = new HostClient(port);
    const pending = client.request('host.info', {});
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    reply(1, INFO);
    await expect(client.request('host.info', {})).rejects.toMatchObject({ code: 'closed' });
  });
});
