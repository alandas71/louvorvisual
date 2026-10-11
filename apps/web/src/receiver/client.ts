import type { ChannelMessage } from '@louvorvisual/presentation';
export type Connection = { id: string; token: string; code?: string };
export type RelayState = { paired: boolean; peerOnline: boolean; version: number; message: ChannelMessage | null };
export class ConnectionError extends Error { constructor(message: string, readonly expired = false) { super(message); } }
export const CONTROLLER_KEY = 'lv:receiver:controller';
export const RECEIVER_KEY = 'lv:receiver:screen';
export const RECEIVER_PREFERENCE = 'lv:receiver:preferred';
export function storedConnection(key: string): Connection | null {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && typeof value.token === 'string' ? value : null; } catch { return null; }
}
export async function relayRequest<T>(method: string, connection: Connection | null, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch('/receiver-link' + (connection ? '?id=' + encodeURIComponent(connection.id) : ''), { method, cache: 'no-store', headers: { ...(connection ? { authorization: 'Bearer ' + connection.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) }); }
  catch { throw new ConnectionError('Sem conexão com o servidor. Verifique a rede dos dois dispositivos.'); }
  let data;
  try { data = await response.json(); } catch { throw new ConnectionError('O servidor não está disponível para conectar o receptor.'); }
  if (!response.ok) throw new ConnectionError(data.error ?? 'Não foi possível conectar.', response.status === 401);
  return data as T;
}
/** Ordered writes, bounded queue, retrying reads. Every state contains the full frame. */
export function openRemoteController(onMessage: (message: unknown) => void) {
  const connection = storedConnection(CONTROLLER_KEY);
  if (!connection) return null;
  let closed = false; let closing = false; let timer: ReturnType<typeof setTimeout>;
  let queued: ChannelMessage[] = []; let writing = false;
  async function flush() {
    if (writing || closed) return; writing = true;
    try {
      while (!closed && queued.length) {
        const message = queued[0]!;
        await relayRequest('POST', connection, { action: 'publish', message });
        queued.shift();
      }
    } catch (error) { if (error instanceof ConnectionError && error.expired) { sessionStorage.removeItem(CONTROLLER_KEY); queued = []; } }
    finally { writing = false; if (closing) closed = true; }
  }
  async function poll() {
    try { const data = await relayRequest<RelayState>('GET', connection); if (!closed && data.peerOnline && data.message) onMessage(data.message); }
    catch (error) { if (error instanceof ConnectionError && error.expired) { sessionStorage.removeItem(CONTROLLER_KEY); closed = true; } }
    if (!closed && !closing) { void flush(); timer = setTimeout(() => void poll(), 500); }
  }
  void poll();
  return {
    post(message: ChannelMessage) {
      if (closed || closing || !['SESSION_SNAPSHOT', 'VISUAL_STATE', 'SESSION_ENDED', 'SESSION_HANDOFF'].includes(message.type)) return;
      // Replace only an unsent visual update; preserve snapshots and end/handoff ordering.
      const last = queued[queued.length - 1];
      if (queued.length > (writing ? 1 : 0) && message.type === 'VISUAL_STATE' && last?.type === 'VISUAL_STATE' && last.sessionId === message.sessionId) queued[queued.length - 1] = message;
      else if (queued.length < 100) queued.push(message);
      void flush();
    },
    close() { closing = true; clearTimeout(timer); if (!writing && queued.length) void flush(); else if (!writing) closed = true; },
  };
}
