import { entityStateKey, type LocalDocument, type LocalRevision } from '@/local';

/** Debounce da digitação (planejamento/04). */
export const TEXT_SAVE_DELAY_MS = 400;

export type SaveStatus = { state: 'saved' } | { state: 'saving' } | { state: 'error'; error: unknown };

type Write = (documents: LocalDocument[], revisions: LocalRevision[]) => Promise<unknown>;

/**
 * Fila de gravação do editor. Guarda só a versão mais recente de cada
 * documento, grava em ordem e só informa "salvo" depois da confirmação do
 * banco. Se a gravação falha, o conteúdo continua aqui para nova tentativa.
 */
export class DocumentSaver {
  private pending = new Map<string, LocalDocument>();
  private pendingRevisions: LocalRevision[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private failed: unknown = null;

  constructor(
    private readonly write: Write,
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly delayMs: number = TEXT_SAVE_DELAY_MS,
  ) {}

  /** `immediate` é usado nas operações estruturais; a digitação espera o debounce. */
  schedule(documents: readonly LocalDocument[], options: { immediate?: boolean; revisions?: readonly LocalRevision[] } = {}): void {
    for (const document of documents) this.pending.set(entityStateKey(document.entityType, document.document.id), document);
    if (options.revisions) this.pendingRevisions.push(...options.revisions);
    this.failed = null;
    this.onStatus({ state: 'saving' });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (options.immediate) void this.flush();
    else this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Grava agora o que estiver aguardando; resolve quando a fila esvaziar. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0 && this.pendingRevisions.length === 0) return this.running;

    const documents = [...this.pending.values()];
    const revisions = this.pendingRevisions;
    this.pending = new Map();
    this.pendingRevisions = [];
    this.failed = null;
    this.inFlight += 1;
    this.running = this.running.then(async () => {
      try {
        await this.write(documents, revisions);
      } catch (error) {
        // Devolve à fila sem passar por cima de algo mais novo.
        for (const document of documents) {
          const key = entityStateKey(document.entityType, document.document.id);
          if (!this.pending.has(key)) this.pending.set(key, document);
        }
        this.pendingRevisions = [...revisions, ...this.pendingRevisions];
        this.failed = error;
      } finally {
        this.inFlight -= 1;
        this.report();
      }
    });
    return this.running;
  }

  /** Há conteúdo em memória ainda não confirmado pelo banco. */
  hasUnsaved(): boolean {
    return this.pending.size > 0 || this.pendingRevisions.length > 0 || this.inFlight > 0;
  }

  private report(): void {
    if (this.inFlight > 0) return;
    if (this.failed !== null) this.onStatus({ state: 'error', error: this.failed });
    else if (this.pending.size > 0) this.onStatus({ state: 'saving' });
    else this.onStatus({ state: 'saved' });
  }
}
