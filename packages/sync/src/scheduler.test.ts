import { describe, expect, it } from 'vitest';
import type { CycleOutcome } from './coordinator';
import { BACKOFF_MAX_MS, backoffDelay, PERIODIC_MS, SyncScheduler } from './scheduler';

const outcome = (changes: Partial<CycleOutcome>): CycleOutcome => ({ pushed: 0, pulled: 0, adopted: 0, conflictsOpened: 0, uploaded: 0, downloaded: 0, downloadsDeferred: 0, bootstrapped: false, connection: 'idle', retry: false, retryAfterMs: null, error: null, ...changes });

describe('backoff', () => {
  it('começa em poucos segundos, dobra e para em cinco minutos, com variação', () => {
    expect(backoffDelay(1, () => 0.5)).toBe(2000);
    expect(backoffDelay(2, () => 0.5)).toBe(4000);
    expect(backoffDelay(4, () => 0.5)).toBe(16000);
    expect(backoffDelay(1, () => 0)).toBe(1600);
    expect(backoffDelay(1, () => 1)).toBe(2400);
    expect(backoffDelay(30, () => 1)).toBe(BACKOFF_MAX_MS);
  });
});

describe('agendador', () => {
  function harness(results: CycleOutcome[]) {
    const timers: { callback: () => void; ms: number }[] = [];
    const delays: (number | null)[] = [];
    let runs = 0;
    const scheduler = new SyncScheduler({
      run: async () => {
        runs += 1;
        return results.shift() ?? outcome({});
      },
      onOutcome: (_result, next) => delays.push(next),
      setTimer: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimer: () => undefined,
      random: () => 0.5,
    });
    const fire = async () => {
      timers.pop()!.callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { scheduler, fire, delays, runs: () => runs };
  }

  it('falha passageira repete com espera crescente; sucesso volta ao intervalo periódico', async () => {
    const { scheduler, fire, delays } = harness([outcome({ connection: 'offline', retry: true }), outcome({ connection: 'offline', retry: true }), outcome({ connection: 'error', retry: true, retryAfterMs: 60_000 }), outcome({})]);
    scheduler.start();
    await fire();
    await fire();
    await fire();
    await fire();
    expect(delays).toEqual([2000, 4000, 60_000, PERIODIC_MS]);
  });

  it('erro de permissão, validação ou conflito não entra em repetição acelerada', async () => {
    const { scheduler, fire, delays } = harness([outcome({ connection: 'revoked' }), outcome({ connection: 'auth-required' })]);
    scheduler.start();
    await fire();
    await fire();
    expect(delays).toEqual([PERIODIC_MS, PERIODIC_MS]);
  });

  it('pedido feito durante um ciclo roda logo depois dele, mas não fura o backoff de uma falha', async () => {
    const delays: (number | null)[] = [];
    const timers: (() => void)[] = [];
    const results = [outcome({ connection: 'offline', retry: true }), outcome({})];
    const holder: { scheduler?: SyncScheduler } = {};
    const scheduler = (holder.scheduler = new SyncScheduler({
      run: async () => {
        holder.scheduler?.request(0);
        return results.shift() ?? outcome({});
      },
      onOutcome: (_result, next) => delays.push(next),
      setTimer: (callback) => timers.push(callback),
      clearTimer: () => undefined,
      random: () => 0.5,
    }));
    scheduler.start();
    for (let index = 0; index < 2; index += 1) {
      timers.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(delays).toEqual([2000, 0]);
  });

  it('parado não agenda nada', async () => {
    const { scheduler, runs } = harness([]);
    scheduler.request();
    expect(runs()).toBe(0);
    scheduler.start();
    scheduler.stop();
    scheduler.request();
    expect(runs()).toBe(0);
  });
});
