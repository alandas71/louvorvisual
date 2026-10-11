import { randomBytes, randomInt } from 'node:crypto';
import type { ChannelMessage } from '@louvorvisual/presentation';

type Room = { id: string; code: string | null; receiver: string; controller: string | null; created: number; touched: number; visual: ChannelMessage | null; ack: ChannelMessage | null; visualVersion: number; ackVersion: number; receiverSeen: number; controllerSeen: number; generation: number };
export class RelayError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const secret = () => randomBytes(32).toString('hex');
/** Ephemeral rooms: deploy this relay in one persistent Node process, not serverless replicas. */
export class ReceiverRelay {
  private rooms = new Map<string, Room>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private now = () => Date.now()) {}
  private sweep() {
    for (const [id, room] of this.rooms) if (this.now() - room.created > 6 * 60 * 60_000 || this.now() - room.touched > (room.controller ? 120_000 : 600_000)) this.rooms.delete(id);
    for (const [key, item] of this.attempts) if (item.until <= this.now()) this.attempts.delete(key);
  }
  limit(key: string) {
    this.sweep();
    const item = this.attempts.get(key) ?? { count: 0, until: this.now() + 60_000 };
    if (++item.count > 10 || this.attempts.size > 5000) throw new RelayError(429, 'Muitas tentativas. Aguarde um minuto.');
    this.attempts.set(key, item);
  }
  create() {
    this.sweep();
    if (this.rooms.size >= 1000) throw new RelayError(503, 'Receptor temporariamente indisponível.');
    let code: string;
    do { code = String(randomInt(10000000, 100000000)); } while ([...this.rooms.values()].some(room => room.code === code));
    const room: Room = { id: secret(), code, receiver: secret(), controller: null, created: this.now(), touched: this.now(), visual: null, ack: null, visualVersion: 0, ackVersion: 0, receiverSeen: this.now(), controllerSeen: 0, generation: -1 };
    this.rooms.set(room.id, room);
    return { id: room.id, token: room.receiver, code };
  }
  pair(code: string) {
    this.sweep();
    const room = [...this.rooms.values()].find(room => room.code === code && !room.controller && this.now() - room.created < 600_000);
    if (!room) throw new RelayError(404, 'Código inválido ou expirado. Gere outro no projetor.');
    room.controller = secret(); room.code = null; room.touched = this.now(); room.controllerSeen = this.now();
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
  read(id: string, token: string) {
    const { room, controller } = this.authorize(id, token);
    return { paired: Boolean(room.controller), peerOnline: this.now() - (controller ? room.receiverSeen : room.controllerSeen) < 3000, version: controller ? room.ackVersion : room.visualVersion, message: controller ? room.ack : room.visual };
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
    } else {
      if (message.type !== 'STATE_ACK' || typeof message.windowId !== 'string' || !Number.isSafeInteger(message.sequenceNumber) || typeof message.armed !== 'boolean' || typeof message.fontMissing !== 'boolean') throw new RelayError(400, 'Confirmação inválida.');
      room.ack = message; room.ackVersion++;
    }
  }
  close(id: string, token: string) { this.authorize(id, token); this.rooms.delete(id); }
}
