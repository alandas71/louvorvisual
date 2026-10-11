import { randomBytes, randomInt } from 'node:crypto';
import type { ChannelMessage } from '@louvorvisual/presentation';

/** Estado da faixa publicado pelo celular: a posição vale para o instante `at` do relógio do servidor. */
export type RelayAudioState = { sha256: string; playing: boolean; positionMs: number; volume: number };
export type ReceiverAudioStatus = 'loading' | 'ready' | 'blocked' | 'failed';
type AudioFile = { sha256: string; mime: string; total: number; received: number; chunks: Buffer[] };
type Room = {
  id: string; code: string | null; codeCreated: number; receiver: string; controller: string | null; created: number; touched: number;
  visual: ChannelMessage | null; ack: ChannelMessage | null; visualVersion: number; ackVersion: number; receiverSeen: number; controllerSeen: number; generation: number;
  /** Cresce a cada mudança que o projetor precisa ver; é o que a leitura em espera acompanha. */
  receiverVersion: number; waiters: Set<() => void>;
  file: AudioFile | null; audio: (RelayAudioState & { at: number }) | null; audioStatus: { sha256: string; status: ReceiverAudioStatus } | null;
};
export class RelayError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const secret = () => randomBytes(32).toString('hex');
const CODE_TTL_MS = 600_000;
const ONLINE_MS = 3000;
/** Sem sinal do celular por este tempo, o projetor volta a oferecer um código. */
const CONTROLLER_GONE_MS = 20_000;
export const AUDIO_CHUNK_BYTES = 256 * 1024;
const AUDIO_ROOM_BYTES = 64 * 1024 * 1024;
const AUDIO_TOTAL_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** Ephemeral rooms: deploy this relay in one persistent Node process, not serverless replicas. */
export class ReceiverRelay {
  private rooms = new Map<string, Room>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private now = () => Date.now()) {}
  private sweep() {
    for (const [id, room] of this.rooms) {
      if (this.now() - room.created <= 24 * 60 * 60_000 && this.now() - room.touched <= (room.controller ? 120_000 : 600_000)) continue;
      this.rooms.delete(id);
      for (const wake of [...room.waiters]) wake();
    }
    for (const [key, item] of this.attempts) if (item.until <= this.now()) this.attempts.delete(key);
  }
  limit(key: string) {
    this.sweep();
    const item = this.attempts.get(key) ?? { count: 0, until: this.now() + 60_000 };
    if (++item.count > 10 || this.attempts.size > 5000) throw new RelayError(429, 'Muitas tentativas. Aguarde um minuto.');
    this.attempts.set(key, item);
  }
  private newCode() {
    let code: string;
    do { code = String(randomInt(1000, 10000)); } while ([...this.rooms.values()].some(room => room.code === code));
    return code;
  }
  private changed(room: Room) {
    room.receiverVersion++;
    for (const wake of [...room.waiters]) wake();
  }
  create() {
    this.sweep();
    if (this.rooms.size >= 1000) throw new RelayError(503, 'Receptor temporariamente indisponível.');
    const code = this.newCode();
    const room: Room = { id: secret(), code, codeCreated: this.now(), receiver: secret(), controller: null, created: this.now(), touched: this.now(), visual: null, ack: null, visualVersion: 0, ackVersion: 0, receiverSeen: this.now(), controllerSeen: 0, generation: -1, receiverVersion: 0, waiters: new Set(), file: null, audio: null, audioStatus: null };
    this.rooms.set(room.id, room);
    return { id: room.id, token: room.receiver, code };
  }
  /** O código vale uma vez. Parear de novo (celular trocado ou que sumiu) substitui o controle anterior. */
  pair(code: string) {
    this.sweep();
    const room = [...this.rooms.values()].find(room => room.code === code && this.now() - room.codeCreated < CODE_TTL_MS);
    if (!room) throw new RelayError(404, 'Código inválido ou expirado. Gere outro no projetor.');
    if (room.controller) { room.visual = null; room.ack = null; room.audio = null; }
    room.controller = secret(); room.code = null; room.created = this.now(); room.touched = this.now(); room.controllerSeen = this.now();
    this.changed(room);
    return { id: room.id, token: room.controller };
  }
  private authorize(id: string, token: string) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || !token || (token !== room.receiver && token !== room.controller)) throw new RelayError(401, 'Conexão encerrada. Conecte os dispositivos novamente.');
    room.touched = this.now();
    if (token === room.controller) room.controllerSeen = this.now(); else room.receiverSeen = this.now();
    return { room, controller: token === room.controller };
  }
  /** O projetor sempre tem um código válido enquanto não há celular respondendo. */
  private refreshCode(room: Room) {
    const absent = !room.controller || this.now() - room.controllerSeen > CONTROLLER_GONE_MS;
    if (!absent) room.code = null;
    else if (!room.code || this.now() - room.codeCreated >= CODE_TTL_MS - 60_000) { room.code = this.newCode(); room.codeCreated = this.now(); }
  }
  read(id: string, token: string) {
    const { room, controller } = this.authorize(id, token);
    if (controller) {
      // Uma leitura em espera do projetor também conta como presença.
      const peerOnline = room.waiters.size > 0 || this.now() - room.receiverSeen < ONLINE_MS;
      return { paired: true, peerOnline, version: room.ackVersion, message: room.ack, audioStatus: room.audioStatus };
    }
    this.refreshCode(room);
    const playing = room.audio;
    const audio = playing && { sha256: playing.sha256, playing: playing.playing, positionMs: playing.positionMs, volume: playing.volume, ageMs: Math.max(0, this.now() - playing.at), available: room.file?.sha256 === playing.sha256 && room.file.received === room.file.total };
    return { paired: Boolean(room.controller), peerOnline: this.now() - room.controllerSeen < ONLINE_MS, version: room.receiverVersion, message: room.visual, code: room.code, audio };
  }
  /** Leitura do projetor que só responde quando algo muda (ou no fim do prazo): troca de slide sem esperar a próxima consulta. */
  async wait(id: string, token: string, version: number, timeoutMs: number) {
    const { room, controller } = this.authorize(id, token);
    if (!controller && room.receiverVersion === version) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); room.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, timeoutMs);
        room.waiters.add(wake);
      });
    }
    return this.read(id, token);
  }
  publish(id: string, token: string, message: ChannelMessage) {
    const { room, controller } = this.authorize(id, token);
    if (!message || typeof message.sessionId !== 'string' || !Number.isFinite('generation' in message ? message.generation : NaN)) throw new RelayError(400, 'Mensagem inválida.');
    if (controller) {
      if (message.type === 'SESSION_SNAPSHOT') {
        if (!message.state?.frame?.slide || !message.state.controls || !message.info || !Number.isSafeInteger(message.state.sequenceNumber)) throw new RelayError(400, 'Estado inválido.');
        if (message.generation < room.generation || (message.generation === room.generation && room.visual?.type !== 'SESSION_SNAPSHOT')) return;
        room.generation = message.generation;
        room.visual = message;
      } else if (message.type === 'VISUAL_STATE') {
        if (room.visual?.type !== 'SESSION_SNAPSHOT' || room.visual.sessionId !== message.sessionId || room.visual.generation !== message.generation) return;
        if (!message.state || !Number.isSafeInteger(message.state.sequenceNumber)) throw new RelayError(400, 'Estado inválido.');
        if (message.state.sequenceNumber < room.visual.state.sequenceNumber) return;
        room.visual = { ...room.visual, state: message.state };
      } else if (message.type === 'SESSION_ENDED' || message.type === 'SESSION_HANDOFF') {
        if (room.visual?.sessionId !== message.sessionId || ('generation' in room.visual && room.visual.generation !== message.generation)) return;
        room.visual = message;
      } else return;
      room.visualVersion++;
      this.changed(room);
    } else {
      if (message.type !== 'STATE_ACK' || typeof message.windowId !== 'string' || !Number.isSafeInteger(message.sequenceNumber) || typeof message.armed !== 'boolean' || typeof message.fontMissing !== 'boolean') throw new RelayError(400, 'Confirmação inválida.');
      room.ack = message; room.ackVersion++;
    }
  }
  /** Celular: posição atual da faixa (`null` encerra). `latencyMs` é a estimativa dele do tempo de subida. Devolve o que o projetor informou. */
  setAudio(id: string, token: string, state: RelayAudioState | null, latencyMs = 0) {
    const { room, controller } = this.authorize(id, token);
    if (!controller) throw new RelayError(403, 'Somente o controle publica o áudio.');
    if (state === null) {
      if (room.audio) { room.audio = null; this.changed(room); }
    } else {
      if (!SHA256.test(state.sha256) || typeof state.playing !== 'boolean' || !Number.isFinite(state.positionMs) || state.positionMs < 0 || !Number.isFinite(state.volume)) throw new RelayError(400, 'Áudio inválido.');
      const lag = Number.isFinite(latencyMs) ? Math.min(2000, Math.max(0, latencyMs)) : 0;
      room.audio = { sha256: state.sha256, playing: state.playing, positionMs: state.positionMs, volume: Math.min(1, Math.max(0, state.volume)), at: this.now() - lag };
      this.changed(room);
    }
    const file = room.file && room.file.sha256 === state?.sha256 ? { received: room.file.received, total: room.file.total } : null;
    return { peerOnline: room.waiters.size > 0 || this.now() - room.receiverSeen < ONLINE_MS, audioStatus: room.audioStatus, file };
  }
  /** Projetor: se a faixa está pronta para tocar aqui. Enquanto não estiver, o celular continua audível. */
  setAudioStatus(id: string, token: string, sha256: string, status: ReceiverAudioStatus) {
    const { room, controller } = this.authorize(id, token);
    if (controller) throw new RelayError(403, 'Somente o projetor informa o áudio.');
    if (!SHA256.test(sha256) || !['loading', 'ready', 'blocked', 'failed'].includes(status)) throw new RelayError(400, 'Estado de áudio inválido.');
    room.audioStatus = { sha256, status };
  }
  private audioBytesInUse() {
    let bytes = 0;
    for (const room of this.rooms.values()) bytes += room.file?.received ?? 0;
    return bytes;
  }
  /** Celular: envia a faixa em partes, em ordem. Devolve quanto já chegou, para retomar um envio interrompido. */
  putAudio(id: string, token: string, file: { sha256: string; mime: string; total: number; offset: number }, bytes: Uint8Array) {
    const { room, controller } = this.authorize(id, token);
    if (!controller) throw new RelayError(403, 'Somente o controle envia o áudio.');
    if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.total) || file.total <= 0 || !Number.isSafeInteger(file.offset) || bytes.byteLength > AUDIO_CHUNK_BYTES * 2) throw new RelayError(400, 'Áudio inválido.');
    if (file.total > AUDIO_ROOM_BYTES) throw new RelayError(413, 'A faixa é grande demais para tocar no projetor.');
    if (room.file?.sha256 !== file.sha256 || room.file.total !== file.total) room.file = { sha256: file.sha256, mime: /^audio\/[\w.+-]+$/.test(file.mime) ? file.mime : 'application/octet-stream', total: file.total, received: 0, chunks: [] };
    const stored = room.file;
    if (file.offset === stored.received && bytes.byteLength > 0 && stored.received + bytes.byteLength <= stored.total) {
      if (this.audioBytesInUse() + bytes.byteLength > AUDIO_TOTAL_BYTES) throw new RelayError(507, 'Sem espaço no servidor para enviar a faixa ao projetor.');
      stored.chunks.push(Buffer.from(bytes)); stored.received += bytes.byteLength;
      if (stored.received === stored.total) this.changed(room);
    }
    return { received: stored.received, total: stored.total };
  }
  getAudio(id: string, token: string, sha256: string) {
    const { room } = this.authorize(id, token);
    if (room.file?.sha256 !== sha256 || room.file.received !== room.file.total) throw new RelayError(404, 'Áudio indisponível.');
    return { mime: room.file.mime, bytes: Buffer.concat(room.file.chunks) };
  }
  close(id: string, token: string) {
    const { room } = this.authorize(id, token);
    this.rooms.delete(id);
    for (const wake of [...room.waiters]) wake();
  }
}
