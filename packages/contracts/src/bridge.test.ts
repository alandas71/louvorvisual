import { describe, expect, it } from 'vitest';
import {
  BRIDGE_VERSION,
  HOST_EVENTS,
  HOST_METHODS,
  hostEvents,
  hostMessageSchema,
  hostMethods,
  hostRequestSchema,
  presentableSchema,
  remoteKeyEventSchema,
} from './bridge';
import { arrangement, song } from './fixtures';

describe('ponte do projetor', () => {
  it('a superfície é a declarada: 26 métodos e 5 eventos, cada um com esquema', () => {
    expect(HOST_METHODS).toHaveLength(26);
    expect(HOST_EVENTS).toEqual(['remote.key', 'audio.state', 'files.progress', 'account.changed', 'host.lifecycle']);
    for (const method of HOST_METHODS) {
      expect(typeof hostMethods[method].params.safeParse).toBe('function');
      expect(typeof hostMethods[method].result.safeParse).toBe('function');
    }
    for (const event of HOST_EVENTS) expect(typeof hostEvents[event].safeParse).toBe('function');
  });

  it('pedido com método desconhecido, versão diferente ou campo a mais é recusado', () => {
    const request = { v: BRIDGE_VERSION, kind: 'request', id: 1, method: 'host.info', params: {} };
    expect(hostRequestSchema.safeParse(request).success).toBe(true);
    expect(hostRequestSchema.safeParse({ ...request, method: 'files.readBytes' }).success).toBe(false);
    expect(hostRequestSchema.safeParse({ ...request, v: 2 }).success).toBe(false);
    expect(hostRequestSchema.safeParse({ ...request, token: 'x' }).success).toBe(false);
    expect(hostRequestSchema.safeParse({ ...request, id: 0 }).success).toBe(false);
  });

  it('parâmetros são estritos: não existe campo para token, senha ou bytes', () => {
    expect(hostMethods['account.signIn'].params.safeParse({ email: 'a@b.c', password: 'x' }).success).toBe(false);
    expect(hostMethods['audio.load'].params.safeParse({ assetId: song.id, sha256: 'a'.repeat(64), bytes: 'AAAA' }).success).toBe(false);
    expect(hostMethods['library.listSongs'].params.safeParse({ cursor: null, limit: 500 }).success).toBe(false);
    expect(hostMethods['prefs.set'].params.safeParse({ prefs: { rotation: 45 } }).success).toBe(false);
    expect(hostMethods['prefs.set'].params.safeParse({ prefs: { rotation: 90 } }).success).toBe(true);
  });

  it('mensagens do host: resposta, erro e evento; tipo desconhecido não passa', () => {
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'response', id: 3, ok: true, result: {} }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'error', id: 3, error: { code: 'not-found', message: '' } }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'error', id: 3, error: { code: 'whatever', message: '' } }).success).toBe(false);
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'event', event: 'remote.key', payload: {} }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'event', event: 'remote.pointer', payload: {} }).success).toBe(false);
    expect(hostMessageSchema.safeParse({ v: 1, kind: 'eval', code: 'alert(1)' }).success).toBe(false);
  });

  it('tecla do controle: só as oito teclas, com sequência e repetição inteiras', () => {
    const key = { epoch: 'a', seq: 0, key: 'left', action: 'down', repeat: 0 };
    expect(remoteKeyEventSchema.safeParse(key).success).toBe(true);
    expect(remoteKeyEventSchema.safeParse({ ...key, key: 'home' }).success).toBe(false);
    expect(remoteKeyEventSchema.safeParse({ ...key, seq: -1 }).success).toBe(false);
    expect(remoteKeyEventSchema.safeParse({ ...key, repeat: 0.5 }).success).toBe(false);
    expect(remoteKeyEventSchema.safeParse({ ...key, action: 'press' }).success).toBe(false);
  });

  it('o que vai ser apresentado passa pelos mesmos esquemas estritos dos documentos', () => {
    const presentable = { song, arrangement, songGeneration: 1, arrangementGeneration: 1, audio: null, audioMissing: false };
    expect(presentableSchema.safeParse(presentable).success).toBe(true);
    expect(presentableSchema.safeParse({ ...presentable, song: { ...song, sessionToken: 'x' } }).success).toBe(false);
    expect(presentableSchema.safeParse({ ...presentable, arrangement: { ...arrangement, occurrences: 'nenhuma' } }).success).toBe(false);
  });
});
