import { SUSPENSION_THRESHOLD_MS } from '@louvorvisual/presentation';
import { describe, expect, it } from 'vitest';
import { SuspensionDetector } from './controller';

describe('detecção de suspensão pelo batimento', () => {
  it('batimentos no ritmo normal, mesmo atrasados por uma aba em segundo plano, não contam', () => {
    const detector = new SuspensionDetector(1_000_000);
    let now = 1_000_000;
    for (const gap of [1000, 1000, 1200, 2000, SUSPENSION_THRESHOLD_MS]) {
      now += gap;
      expect(detector.beat(now), `intervalo de ${gap} ms`).toBe(false);
    }
  });

  it('um intervalo maior que o limite indica que o dispositivo dormiu, uma única vez', () => {
    const detector = new SuspensionDetector(0);
    expect(detector.beat(1000)).toBe(false);
    // O computador dormiu um minuto entre dois batimentos.
    expect(detector.beat(61_000)).toBe(true);
    // O batimento seguinte já é normal: a suspensão não é anunciada de novo.
    expect(detector.beat(62_000)).toBe(false);
    expect(detector.beat(62_000 + SUSPENSION_THRESHOLD_MS + 1)).toBe(true);
  });
});
