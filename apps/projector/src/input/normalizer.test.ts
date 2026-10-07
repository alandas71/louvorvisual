import type { RemoteKey, RemoteKeyEvent } from '@louvorvisual/contracts';
import { describe, expect, it } from 'vitest';
import { HELD_EXPIRY_MS, KeyNormalizer, REPEAT_INTERVAL_MS, type InputContext } from './normalizer';

const SLIDE: InputContext = { repeat: 'none', scope: 1 };
const MENU: InputContext = { repeat: 'directions', scope: 2 };

function harness() {
  const normalizer = new KeyNormalizer();
  let seq = 0;
  let now = 1000;
  const send = (key: RemoteKey, action: 'down' | 'up', repeat: number, context: InputContext, advance = 50) => {
    now += advance;
    const event: RemoteKeyEvent = { epoch: 'e1', seq: seq++, key, action, repeat };
    return normalizer.accept(event, context, now).command;
  };
  return { normalizer, send, wait: (ms: number) => (now += ms), raw: (event: RemoteKeyEvent, context: InputContext) => normalizer.accept(event, context, (now += 10)) };
}

describe('teclas do controle → comandos', () => {
  it('um pressionamento (down + up) produz exatamente um comando', () => {
    const { send, normalizer } = harness();
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
    expect(send('right', 'up', 0, SLIDE)).toBeNull();
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
    expect(send('right', 'up', 0, SLIDE)).toBeNull();
    expect(normalizer.stats.accepted).toBe(2);
  });

  it('tecla mantida na apresentação limpa: só o pressionamento inicial vale, por mais que repita', () => {
    const { send, normalizer } = harness();
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
    for (let repeat = 1; repeat <= 40; repeat += 1) expect(send('right', 'down', repeat, SLIDE)).toBeNull();
    expect(send('right', 'up', 0, SLIDE)).toBeNull();
    expect(normalizer.stats).toMatchObject({ accepted: 1, repeat: 40 });
    // Solta e aperta de novo: volta a valer.
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
  });

  it('host que repete `down` com repeat 0 sem enviar `up` não pula vários slides', () => {
    const { send } = harness();
    expect(send('left', 'down', 0, SLIDE)).toBe('left');
    expect(send('left', 'down', 0, SLIDE)).toBeNull();
    expect(send('left', 'down', 0, SLIDE)).toBeNull();
  });

  it('`up` perdido não trava a tecla para sempre', () => {
    const { send, wait } = harness();
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
    wait(HELD_EXPIRY_MS);
    expect(send('right', 'down', 0, SLIDE)).toBe('right');
  });

  it('mensagem repetida pela ponte (mesma sequência) é descartada', () => {
    const { raw, normalizer } = harness();
    const down: RemoteKeyEvent = { epoch: 'e1', seq: 7, key: 'right', action: 'down', repeat: 0 };
    const up: RemoteKeyEvent = { epoch: 'e1', seq: 8, key: 'right', action: 'up', repeat: 0 };
    expect(raw(down, SLIDE).command).toBe('right');
    expect(raw(down, SLIDE)).toEqual({ command: null, reason: 'duplicate' });
    expect(raw(up, SLIDE).command).toBeNull();
    // Reentrega fora de ordem do `down` já processado, depois do `up`.
    expect(raw(down, SLIDE)).toEqual({ command: null, reason: 'duplicate' });
    expect(normalizer.stats).toMatchObject({ accepted: 1, duplicate: 2 });
  });

  it('host reiniciado: a sequência recomeça e as teclas voltam a valer', () => {
    const { raw } = harness();
    expect(raw({ epoch: 'e1', seq: 50, key: 'ok', action: 'down', repeat: 0 }, SLIDE).command).toBe('ok');
    expect(raw({ epoch: 'e2', seq: 0, key: 'ok', action: 'down', repeat: 0 }, SLIDE).command).toBe('ok');
  });

  it('em menu e lista as setas repetem, com ritmo limitado; OK, Voltar, Menu e play/pause nunca repetem', () => {
    const { send, normalizer } = harness();
    expect(send('down', 'down', 0, MENU)).toBe('down');
    expect(send('down', 'down', 1, MENU, REPEAT_INTERVAL_MS)).toBe('down');
    expect(send('down', 'down', 2, MENU, 10)).toBeNull();
    expect(send('down', 'down', 3, MENU, REPEAT_INTERVAL_MS)).toBe('down');
    expect(send('down', 'up', 0, MENU)).toBeNull();
    for (const key of ['ok', 'back', 'menu', 'playPause'] as const) {
      expect(send(key, 'down', 0, MENU)).toBe(key);
      expect(send(key, 'down', 1, MENU, 200)).toBeNull();
      expect(send(key, 'down', 2, MENU, 200)).toBeNull();
      expect(send(key, 'up', 0, MENU)).toBeNull();
    }
    expect(normalizer.stats.throttled).toBe(1);
  });

  it('tecla mantida não atravessa a troca de contexto: abrir os controles segurando ↓ não percorre os botões', () => {
    const { send, normalizer } = harness();
    expect(send('down', 'down', 0, SLIDE)).toBe('down');
    // O primeiro ↓ abriu os controles; a repetição agora chega com o contexto novo.
    for (let repeat = 1; repeat <= 10; repeat += 1) expect(send('down', 'down', repeat, MENU, 100)).toBeNull();
    expect(normalizer.stats['held-across-contexts']).toBe(10);
    expect(send('down', 'up', 0, MENU)).toBeNull();
    expect(send('down', 'down', 0, MENU)).toBe('down');
  });

  it('segurar → no menu e fechá-lo não começa a passar slides', () => {
    const { send } = harness();
    expect(send('right', 'down', 0, MENU)).toBe('right');
    expect(send('right', 'down', 1, MENU, 100)).toBe('right');
    for (let repeat = 2; repeat <= 10; repeat += 1) expect(send('right', 'down', repeat, SLIDE, 100)).toBeNull();
  });
});
