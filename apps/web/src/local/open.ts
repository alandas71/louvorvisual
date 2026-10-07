import type { LocalDatabase } from './db';
import { isQuotaError } from './repository';
import { LOCAL_DB_VERSION } from './schema';

/**
 * Menor versão de código que ainda pode gravar neste formato de dados. A
 * versão 6 só acrescenta tabela e índice, então o código da 5 continua
 * compatível; uma mudança que o código antigo estragaria sobe este número.
 */
export const LOCAL_DB_MIN_READER = 5;

/** Marcador gravado em `meta`: o Dexie abre um banco mais novo sem avisar, então a recusa é nossa. */
export type SchemaMarker = { key: 'schema'; version: number; minReader: number };

export type LocalOpenErrorCode = 'newer-data' | 'quota' | 'corrupted' | 'unavailable';

const OPEN_ERROR_TEXT: Record<LocalOpenErrorCode, string> = {
  'newer-data':
    'Os dados deste dispositivo já foram atualizados por uma versão mais nova do LouvorVisual, e esta versão não pode gravá-los com segurança. Nada foi alterado. Atualize o aplicativo em "Disponível offline" (ou recarregue a página com conexão) para continuar.',
  quota: 'Não há espaço neste dispositivo para abrir os dados. Nada foi apagado. Libere espaço no disco e abra de novo.',
  corrupted:
    'O navegador não conseguiu ler o banco de dados deste dispositivo. Nada foi apagado pelo aplicativo. Feche todas as janelas do LouvorVisual e abra de novo; se continuar, recupere o conteúdo entrando na equipe ou importando um pacote exportado.',
  unavailable: 'Este navegador não está permitindo guardar dados (janela anônima, armazenamento bloqueado ou desativado). Sem isso o LouvorVisual não consegue abrir a biblioteca.',
};

/** Falha ao abrir os dados locais, com o que o operador pode fazer. O banco nunca é apagado para "consertar". */
export class LocalOpenError extends Error {
  constructor(
    readonly code: LocalOpenErrorCode,
    options?: { cause?: unknown },
  ) {
    super(OPEN_ERROR_TEXT[code], options);
    this.name = 'LocalOpenError';
  }
}

export function classifyOpenError(error: unknown): LocalOpenError {
  if (error instanceof LocalOpenError) return error;
  const names: string[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const { name, inner } = current as { name?: string; inner?: unknown };
    if (name) names.push(name);
    current = inner;
  }
  if (isQuotaError(error)) return new LocalOpenError('quota', { cause: error });
  if (names.includes('VersionError')) return new LocalOpenError('newer-data', { cause: error });
  if (names.some((name) => name === 'MissingAPIError' || name === 'SecurityError' || name === 'InvalidStateError')) return new LocalOpenError('unavailable', { cause: error });
  return new LocalOpenError('corrupted', { cause: error });
}

/**
 * Confere e atualiza o marcador de formato. Um banco gravado por código mais
 * novo que declara este código incompatível não é aberto para escrita; o
 * marcador nunca é rebaixado por uma versão antiga.
 */
export async function ensureCompatible(db: LocalDatabase): Promise<void> {
  const meta = db.table<SchemaMarker, string>('meta');
  await db.transaction('rw', meta, async () => {
    const marker = await meta.get('schema');
    if (marker && marker.minReader > LOCAL_DB_VERSION) throw new LocalOpenError('newer-data');
    if (!marker || marker.version < LOCAL_DB_VERSION) await meta.put({ key: 'schema', version: LOCAL_DB_VERSION, minReader: LOCAL_DB_MIN_READER });
  });
}

/** Tempo para o editor concluir a gravação pendente antes de a conexão ser fechada. */
export const SUPERSEDE_GRACE_MS = 1_500;

export type ConnectionEvents = {
  /** Esta janela está em apresentação (área do operador ou projeção). */
  isPresenting(): boolean;
  /** Outra janela, com versão mais nova, quer migrar o banco e esta fechou a conexão para deixar. */
  onSuperseded(): void;
  /** Esta janela quer migrar o banco e outra, mais antiga, ainda o está usando. */
  onBlocked(): void;
};

/**
 * Convivência entre janelas de versões diferentes (planejamento/08): uma
 * janela em apresentação nunca entrega a conexão — a migração da outra janela
 * espera; as demais fecham a conexão e avisam que precisam recarregar.
 */
export function guardConnection(db: LocalDatabase, events: ConnectionEvents): void {
  db.on('versionchange', () => {
    if (events.isPresenting()) return false;
    // Primeiro o aviso (o editor grava o que está em memória), depois o fechamento.
    events.onSuperseded();
    setTimeout(() => db.close(), SUPERSEDE_GRACE_MS);
    return false;
  });
  db.on('blocked', () => events.onBlocked());
}
