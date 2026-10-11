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
const AUDIO_CACHE = 'lv-receiver-audio';
const AUDIO_CACHE_ENTRIES = 12;
async function cachedAudio(sha256: string): Promise<Blob | null> {
  try { return (await (await caches.open(AUDIO_CACHE)).match('/receiver-audio/' + sha256))?.blob() ?? null; } catch { return null; }
}
async function keepAudio(sha256: string, blob: Blob) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put('/receiver-audio/' + sha256, new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - AUDIO_CACHE_ENTRIES))) await cache.delete(old);
  } catch { /* Sem cache (ou sem espaço), a faixa é baixada de novo na próxima vez. */ }
}
/** Bytes da faixa que o celular enviou a esta sala. */
export async function relayAudioBlob(connection: Connection, sha256: string): Promise<Blob> {
  // O projetor guarda as faixas que já tocou: repetir um louvor não baixa nada.
  const kept = await cachedAudio(sha256);
  if (kept) return kept;
  const response = await relayFetch('GET', connection, undefined, { query: 'audio=' + sha256, timeoutMs: 120_000 });
  if (!response.ok) throw new ConnectionError('Áudio indisponível.', response.status === 401);
  const blob = await response.blob();
  void keepAudio(sha256, blob);
  return blob;
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

/** Onde a faixa da sessão está saindo, para o operador ver no painel sem olhar o projetor. */
export type RemoteAudioStatus = { state: 'none' | 'offline' | 'sending' | 'loading' | 'projector' | 'blocked' | 'failed'; progress: number };
let remoteAudio: RemoteAudioStatus = { state: 'none', progress: 0 };
const remoteAudioListeners = new Set<() => void>();
function setRemoteAudio(state: RemoteAudioStatus['state'], progress = 0) {
  if (remoteAudio.state === state && remoteAudio.progress === progress) return;
  remoteAudio = { state, progress };
  for (const listener of [...remoteAudioListeners]) listener();
}
export const remoteAudioStatus = () => remoteAudio;
export function subscribeRemoteAudio(listener: () => void) { remoteAudioListeners.add(listener); return () => { remoteAudioListeners.delete(listener); }; }

type AudioReply = { peerOnline: boolean; audioStatus: { sha256: string; status: ReceiverAudioStatus } | null; file: { received: number; total: number; missing: number[] } | null };
const UPLOAD_LANES = 4;
const QUIET_VOLUME = 0.001;
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
  let latencyMs = 60; let uploading = false; let answeredAt = performance.now();
  // Com o som no projetor, o player daqui segue tocando quase inaudível em vez de mudo: no Android,
  // uma página que toca áudio continua viva com a tela bloqueada, e é este player o relógio da letra
  // e da faixa do projetor. Onde o volume não pode ser mudado (iOS), fica mudo mesmo.
  let silenced = false; let volume = element.volume;
  function silence(on: boolean) {
    if (on === silenced) return;
    silenced = on;
    if (on) { volume = element.volume; element.volume = QUIET_VOLUME; element.muted = element.volume > QUIET_VOLUME * 2; }
    else { element.muted = false; element.volume = volume; }
  }
  // O operador mexeu no volume enquanto o som está no projetor: guarda o valor e mantém este player quieto.
  const keepQuiet = () => { if (silenced && element.volume > QUIET_VOLUME * 2 && !element.muted) { volume = element.volume; element.volume = QUIET_VOLUME; } };
  element.addEventListener('volumechange', keepQuiet);
  /** Envia as partes que faltam, algumas ao mesmo tempo: em rede lenta o que pesa é a espera de cada pedido. */
  async function upload(missing: number[]) {
    if (uploading || closed) return; uploading = true;
    const queue = [...missing];
    const send = async () => {
      for (let offset = queue.shift(); offset !== undefined && !closed; offset = queue.shift()) {
        const part = blob.slice(offset, offset + AUDIO_CHUNK_BYTES);
        const reply = await relayRequest<{ received: number; total: number }>('PUT', connection, undefined, { query: `sha=${sha256}&total=${blob.size}&offset=${offset}`, timeoutMs: 60_000, raw: { body: part, type: blob.type || 'application/octet-stream' } });
        if (!closed) setRemoteAudio('sending', Math.floor((reply.received / reply.total) * 100));
      }
    };
    try { await Promise.all(Array.from({ length: UPLOAD_LANES }, send)); void beat(); }
    catch { /* A próxima batida pergunta ao servidor o que falta e retoma dali. */ }
    finally { uploading = false; }
  }
  async function beat() {
    if (closed) return;
    if (sending) { again = true; return; }
    sending = true; clearTimeout(timer);
    try {
      const startedAt = performance.now();
      const state: RelayAudioState = { sha256, playing: !element.paused && !element.ended, positionMs: element.currentTime * 1000, volume: silenced ? volume : element.volume };
      const reply = await relayRequest<AudioReply>('POST', connection, { action: 'audio', state, latencyMs: latencyMs / 2 });
      latencyMs = latencyMs * 0.7 + (performance.now() - startedAt) * 0.3;
      if (closed) return;
      answeredAt = performance.now();
      const pending = reply.file ? reply.file.missing : Array.from({ length: Math.ceil(blob.size / AUDIO_CHUNK_BYTES) }, (_, index) => index * AUDIO_CHUNK_BYTES);
      if (pending.length) void upload(pending);
      const reported = reply.audioStatus?.sha256 === sha256 ? reply.audioStatus.status : null;
      silence(reply.peerOnline && reported === 'ready');
      if (!reply.peerOnline) setRemoteAudio('offline');
      else if (pending.length) setRemoteAudio('sending', Math.floor(((reply.file?.received ?? 0) / blob.size) * 100));
      else setRemoteAudio(reported === 'ready' ? 'projector' : reported === 'blocked' || reported === 'failed' ? reported : 'loading');
    } catch (error) {
      if (error instanceof ConnectionError && error.expired) { close(); return; }
      // Uma falha isolada não muda nada; sem servidor por mais tempo, o projetor
      // também para de tocar (ver useReceiverAudio) e o som volta ao celular.
      if (performance.now() - answeredAt > SILENT_PEER_MS) { silence(false); setRemoteAudio('offline'); }
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
    silence(false); element.removeEventListener('volumechange', keepQuiet); setRemoteAudio('none');
    void relayRequest('POST', connection, { action: 'audio', state: null }).catch(() => {});
  }
  return { close };
}
