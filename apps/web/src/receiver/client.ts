import type { ChannelMessage } from '@louvorvisual/presentation';
import type { ReceiverAudioStatus, RelayAudioState } from './relay';
export type Connection = { id: string; token: string; code?: string };
/** Faixa como o projetor a recebe: `ageMs` é há quanto tempo o servidor recebeu a posição. */
export type RelayAudio = RelayAudioState & { ageMs: number; available: boolean };
export type RelayState = { paired: boolean; peerOnline: boolean; version: number; message: ChannelMessage | null; code?: string | null; audio?: RelayAudio | null; audioStatus?: { sha256: string; status: ReceiverAudioStatus } | null };
export class ConnectionError extends Error { constructor(message: string, readonly expired = false) { super(message); } }
export const CONTROLLER_KEY = 'lv:receiver:controller';
export const RECEIVER_KEY = 'lv:receiver:screen';
export const RECEIVER_PREFERENCE = 'lv:receiver:preferred';
/** Igual ao limite por parte aceito pelo relay; cabe no corpo padrão de 1 MB dos proxies. */
const AUDIO_CHUNK_BYTES = 256 * 1024;
export function storedConnection(key: string, storage: 'sessionStorage' | 'localStorage' = 'sessionStorage'): Connection | null {
  try { const value = JSON.parse(window[storage].getItem(key) ?? 'null'); return value && typeof value.id === 'string' && typeof value.token === 'string' ? value : null; } catch { return null; }
}
type RelayRequest = { query?: string; timeoutMs?: number; raw?: { body: Blob; type: string } };
async function relayFetch(method: string, connection: Connection | null, body: unknown, options: RelayRequest): Promise<Response> {
  const query = [connection ? 'id=' + encodeURIComponent(connection.id) : '', options.query ?? ''].filter(Boolean).join('&');
  const headers = { ...(connection ? { authorization: 'Bearer ' + connection.token } : {}), ...(options.raw ? { 'content-type': options.raw.type } : body ? { 'content-type': 'application/json' } : {}) };
  try { return await fetch('/receiver-link' + (query ? '?' + query : ''), { method, cache: 'no-store', headers, body: options.raw ? options.raw.body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) }); }
  catch { throw new ConnectionError('Sem conexão com o servidor. Verifique a rede dos dois dispositivos.'); }
}
export async function relayRequest<T>(method: string, connection: Connection | null, body?: unknown, options: RelayRequest = {}): Promise<T> {
  const response = await relayFetch(method, connection, body, options);
  let data;
  try { data = await response.json(); } catch { throw new ConnectionError('O servidor não está disponível para conectar o receptor.'); }
  if (!response.ok) throw new ConnectionError(data.error ?? 'Não foi possível conectar.', response.status === 401);
  return data as T;
}
/** Bytes da faixa que o celular enviou a esta sala. */
export async function relayAudioBlob(connection: Connection, sha256: string): Promise<Blob> {
  const response = await relayFetch('GET', connection, undefined, { query: 'audio=' + sha256, timeoutMs: 120_000 });
  if (!response.ok) throw new ConnectionError('Áudio indisponível.', response.status === 401);
  return response.blob();
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

type AudioReply = { peerOnline: boolean; audioStatus: { sha256: string; status: ReceiverAudioStatus } | null; file: { received: number; total: number } | null };
const AUDIO_BEAT_MS = 1000;
/** Sem notícia do outro lado por este tempo, cada dispositivo assume que o par sumiu. */
export const SILENT_PEER_MS = 6000;

/**
 * Leva a faixa da sessão ao projetor pareado: envia os bytes uma vez e publica
 * a posição do player do celular, que continua sendo o único relógio. Quando o
 * projetor confirma que está tocando, o celular fica mudo; se o projetor sumir
 * ou não conseguir tocar, o som volta ao celular.
 */
export function openRemoteAudio(source: { sha256: string; blob: Blob; element: HTMLAudioElement }) {
  const connection = storedConnection(CONTROLLER_KEY);
  if (!connection) return null;
  const { sha256, blob, element } = source;
  let closed = false; let timer: ReturnType<typeof setTimeout> | undefined; let sending = false; let again = false;
  let latencyMs = 60; let uploading = false; let uploaded = false; let answeredAt = performance.now();
  async function upload(from: number) {
    if (uploading || uploaded || closed) return; uploading = true;
    try {
      let offset = from;
      while (!closed && offset < blob.size) {
        const part = blob.slice(offset, offset + AUDIO_CHUNK_BYTES);
        const reply = await relayRequest<{ received: number }>('PUT', connection, undefined, { query: `sha=${sha256}&total=${blob.size}&offset=${offset}`, timeoutMs: 30_000, raw: { body: part, type: blob.type || 'application/octet-stream' } });
        offset = reply.received;
      }
      uploaded = offset >= blob.size;
    } catch { /* A próxima batida retoma de onde o servidor parou. */ }
    finally { uploading = false; }
  }
  async function beat() {
    if (closed) return;
    if (sending) { again = true; return; }
    sending = true; clearTimeout(timer);
    try {
      const startedAt = performance.now();
      const state: RelayAudioState = { sha256, playing: !element.paused && !element.ended, positionMs: element.currentTime * 1000, volume: element.volume };
      const reply = await relayRequest<AudioReply>('POST', connection, { action: 'audio', state, latencyMs: latencyMs / 2 });
      latencyMs = latencyMs * 0.7 + (performance.now() - startedAt) * 0.3;
      if (closed) return;
      answeredAt = performance.now();
      if (!reply.file || reply.file.received < reply.file.total) { uploaded = false; void upload(reply.file?.received ?? 0); }
      element.muted = reply.peerOnline && reply.audioStatus?.sha256 === sha256 && reply.audioStatus.status === 'ready';
    } catch (error) {
      if (error instanceof ConnectionError && error.expired) { close(); return; }
      // Uma falha isolada não muda nada; sem servidor por mais tempo, o projetor
      // também para de tocar (ver useReceiverAudio) e o som volta ao celular.
      if (performance.now() - answeredAt > SILENT_PEER_MS) element.muted = false;
    } finally {
      sending = false;
      if (!closed) { if (again) { again = false; void beat(); } else timer = setTimeout(() => void beat(), AUDIO_BEAT_MS); }
    }
  }
  const events = ['play', 'playing', 'pause', 'seeked', 'ended', 'volumechange', 'waiting'] as const;
  const onEvent = () => void beat();
  for (const name of events) element.addEventListener(name, onEvent);
  void beat();
  function close() {
    if (closed) return;
    closed = true; clearTimeout(timer);
    for (const name of events) element.removeEventListener(name, onEvent);
    element.muted = false;
    void relayRequest('POST', connection, { action: 'audio', state: null }).catch(() => {});
  }
  return { close };
}
