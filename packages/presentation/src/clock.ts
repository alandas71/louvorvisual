/** Identificador devolvido pelo agendador; o motor só o guarda para cancelar. */
export type TimerHandle = unknown;

/**
 * Relógio monotônico e agendador usados pelo motor. O agendador serve para
 * acordar o motor; o tempo verdadeiro é sempre lido de `now()`.
 */
export interface EngineClock {
  /** Milissegundos de um relógio monotônico do processo atual. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

type Pending = { id: number; dueAt: number; callback: () => void };

/** Relógio simulado para testes: o tempo só anda quando o teste manda. */
export class ManualClock implements EngineClock {
  private current: number;
  private nextId = 1;
  private pending: Pending[] = [];

  constructor(startAt = 1000) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.pending.push({ id, dueAt: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending = this.pending.filter((item) => item.id !== handle);
  }

  /** Quantos despertadores estão armados. */
  get armed(): number {
    return this.pending.length;
  }

  /** Avança o tempo executando cada despertador no instante em que vence. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const next = this.pending.filter((item) => item.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;
      this.pending = this.pending.filter((item) => item !== next);
      this.current = Math.max(this.current, next.dueAt);
      next.callback();
    }
    this.current = target;
  }

  /**
   * Avança o tempo sem acordar ninguém no caminho e só então executa o que
   * venceu: é o que acontece com um callback atrasado ou uma aba suspensa.
   */
  jump(ms: number): void {
    this.current += ms;
    const due = this.pending.filter((item) => item.dueAt <= this.current).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    this.pending = this.pending.filter((item) => !due.includes(item));
    for (const item of due) item.callback();
  }
}
