import type { CycleOutcome } from './coordinator';

/** Backoff (planejamento/09): começa em poucos segundos, dobra e para em cinco minutos. */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const PERIODIC_MS = 30_000;
/** Pequena espera depois de uma alteração local, para juntar edições seguidas. */
export const CHANGE_DEBOUNCE_MS = 1_500;

/** Espera da tentativa `failures` (1 = primeira falha), com variação de ±20%. */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(Math.min(BACKOFF_MAX_MS, base * (0.8 + random() * 0.4)));
}

export type SchedulerDeps = {
  run: () => Promise<CycleOutcome>;
  onOutcome?: (outcome: CycleOutcome, nextRunInMs: number | null) => void;
  onStart?: () => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  periodicMs?: number;
};

/**
 * Decide quando rodar o próximo ciclo: ao abrir, depois de alteração local,
 * ao voltar a conexão, por ação manual e periodicamente. Erros de validação,
 * permissão e conflito não entram em repetição: só falhas passageiras.
 */
export class SyncScheduler {
  private timer: unknown = null;
  private dueAt = Infinity;
  private failures = 0;
  private active = false;
  private busy = false;
  private again = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.active = true;
    this.request(0);
  }

  stop(): void {
    this.active = false;
    this.cancel();
  }

  /** Pede um ciclo daqui a `delayMs`; um pedido mais próximo substitui o agendado. */
  request(delayMs = 0): void {
    if (!this.active) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    const due = Date.now() + delayMs;
    if (this.timer !== null && due >= this.dueAt) return;
    this.cancel();
    this.dueAt = due;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => void this.fire(), delayMs);
  }

  private cancel(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.dueAt = Infinity;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.dueAt = Infinity;
    if (!this.active || this.busy) return;
    this.busy = true;
    this.again = false;
    this.deps.onStart?.();
    let outcome: CycleOutcome | null = null;
    try {
      outcome = await this.deps.run();
    } finally {
      this.busy = false;
    }
    if (!this.active) return;
    this.failures = outcome.retry ? this.failures + 1 : 0;
    // Depois de uma falha passageira vale o backoff, mesmo com pedido na fila:
    // um pedido feito durante o ciclo só antecipa o próximo quando este deu certo.
    const next = outcome.retry ? Math.max(outcome.retryAfterMs ?? 0, backoffDelay(this.failures, this.deps.random)) : this.again ? 0 : (this.deps.periodicMs ?? PERIODIC_MS);
    this.deps.onOutcome?.(outcome, next);
    this.request(next);
  }
}
