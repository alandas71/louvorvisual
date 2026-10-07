import {
  BRIDGE_VERSION,
  hostEvents,
  hostMessageSchema,
  hostMethods,
  type HostErrorCode,
  type HostEventName,
  type HostEventPayload,
  type HostMethod,
  type HostParams,
  type HostPort,
  type HostRequest,
  type HostResult,
} from '@louvorvisual/contracts';

export type HostFailure =
  | HostErrorCode
  /** O host não respondeu no prazo. */
  | 'timeout'
  /** A resposta não tem o formato do contrato. */
  | 'invalid-response'
  | 'closed';

/** Pedido ao host que não deu certo; `code` diz o que a tela pode fazer. */
export class HostError extends Error {
  constructor(
    readonly code: HostFailure,
    readonly method: HostMethod,
    message = `${method}: ${code}`,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Dependem da pessoa (seletor de arquivos, tela de entrada) ou do tamanho do pacote: sem prazo. */
const UNTIMED: ReadonlySet<HostMethod> = new Set(['files.pickPackage', 'files.applyImport', 'account.signIn']);

type Pending = { method: HostMethod; resolve: (result: unknown) => void; reject: (error: HostError) => void; timer: ReturnType<typeof setTimeout> | null };
type Listener = (payload: never) => void;

/**
 * Lado do bundle na ponte com o host. Cada pedido tem um ID e exatamente uma
 * resposta; resposta sem pedido, repetida ou fora do contrato é descartada.
 * Não conhece Android nem o host simulado: recebe o objeto de mensagens.
 */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<HostEventName, Set<Listener>>();
  private closed = false;
  readonly stats = { sent: 0, responses: 0, events: 0, dropped: 0 };

  constructor(
    private readonly port: HostPort,
    private readonly options: { timeoutMs?: number } = {},
  ) {
    port.onmessage = (event) => this.receive(event.data);
  }

  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    if (this.closed) return Promise.reject(new HostError('closed', method));
    const checked = hostMethods[method].params.safeParse(params);
    if (!checked.success) return Promise.reject(new HostError('invalid-request', method, `${method}: parâmetros fora do contrato`));
    const id = this.nextId++;
    const request: HostRequest = { v: BRIDGE_VERSION, kind: 'request', id, method, params: checked.data as Record<string, unknown> };
    return new Promise<HostResult<M>>((resolve, reject) => {
      const timer = UNTIMED.has(method)
        ? null
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new HostError('timeout', method));
          }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer });
      this.stats.sent += 1;
      try {
        this.port.postMessage(JSON.stringify(request));
      } catch {
        this.settle(id)?.reject(new HostError('closed', method));
      }
    });
  }

  private settle(id: number): Pending | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    return pending;
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    let raw: unknown;
    try {
      raw = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      raw = null;
    }
    const parsed = hostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.stats.dropped += 1;
      return;
    }
    const message = parsed.data;
    if (message.kind === 'event') {
      const payload = hostEvents[message.event].safeParse(message.payload);
      if (!payload.success) {
        this.stats.dropped += 1;
        return;
      }
      this.stats.events += 1;
      for (const listener of [...(this.listeners.get(message.event) ?? [])]) (listener as (payload: unknown) => void)(payload.data);
      return;
    }
    // Resposta sem pedido pendente: atrasada (o prazo já venceu) ou entregue duas vezes.
    const pending = this.settle(message.id);
    if (!pending) {
      this.stats.dropped += 1;
      return;
    }
    this.stats.responses += 1;
    if (message.kind === 'error') {
      pending.reject(new HostError(message.error.code, pending.method, message.error.message || undefined));
      return;
    }
    const result = hostMethods[pending.method].result.safeParse(message.result);
    if (result.success) pending.resolve(result.data);
    else pending.reject(new HostError('invalid-response', pending.method));
  }

  on<E extends HostEventName>(event: E, listener: (payload: HostEventPayload<E>) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set);
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  close(): void {
    this.closed = true;
    this.port.onmessage = null;
    for (const id of [...this.pending.keys()]) {
      const pending = this.settle(id);
      pending?.reject(new HostError('closed', pending.method));
    }
    this.listeners.clear();
  }
}
