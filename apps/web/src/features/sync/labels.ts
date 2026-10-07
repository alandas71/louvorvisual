import type { ConflictKind, ConnectionState, PendingPhase, SyncEntityType } from '@louvorvisual/sync';

export const CONNECTION_TEXT: Record<ConnectionState, { short: string; long: string }> = {
  'local-only': { short: 'Só neste dispositivo', long: 'Este é o perfil pessoal deste dispositivo: nada é enviado a um servidor.' },
  idle: { short: 'Sincronizado', long: 'Conectado. A biblioteca deste dispositivo está em dia com a equipe.' },
  syncing: { short: 'Sincronizando…', long: 'Enviando e recebendo alterações.' },
  offline: { short: 'Sem conexão', long: 'Sem conexão com o servidor. Tudo continua salvo neste dispositivo e será enviado quando a conexão voltar.' },
  'auth-required': { short: 'Entrar de novo', long: 'A sessão online expirou. Entre de novo para sincronizar; as alterações continuam salvas neste dispositivo.' },
  'identity-mismatch': { short: 'Outra conta', long: 'A conta conectada não é a deste perfil. Nada deste perfil é enviado com outra conta.' },
  revoked: { short: 'Acesso revogado', long: 'Seu acesso a esta equipe foi revogado. A sincronização deste espaço está suspensa.' },
  'read-only': { short: 'Somente leitura', long: 'Seu papel nesta equipe não permite publicar. Você recebe a biblioteca; suas alterações ficam só neste dispositivo.' },
  error: { short: 'Erro', long: 'A última sincronização falhou.' },
};

export const PHASE_TEXT: Record<PendingPhase, string> = {
  queued: 'Aguardando envio',
  sending: 'Enviado, aguardando confirmação',
  'waiting-dependency': 'Aguardando outro item ser confirmado',
  'waiting-upload': 'Aguardando o envio do arquivo de áudio',
  conflict: 'Em conflito — precisa de decisão',
  blocked: 'Recusada pelo servidor',
  suspended: 'Suspensa por erro de contrato',
  expired: 'Antiga demais — aguardando reconciliação',
};

export const ENTITY_TEXT: Record<SyncEntityType, string> = { song: 'Louvor', arrangement: 'Arranjo', setlist: 'Repertório', asset: 'Áudio', theme: 'Tema' };

export const CONFLICT_TEXT: Record<ConflictKind, string> = {
  'both-edited': 'Este registro foi alterado aqui e também por outra pessoa a partir da mesma revisão.',
  'remote-deleted': 'Este registro foi excluído pela equipe enquanto você o editava aqui. A sua edição está preservada.',
  'local-deleted': 'Você excluiu este registro aqui, mas outra pessoa o alterou antes de a exclusão chegar.',
};

export const BLOCK_TEXT: Record<string, string> = {
  DEPENDENCY_NOT_READY: 'O servidor ainda não tem um item de que este depende.',
  ENTITY_NOT_FOUND: 'O servidor não conhece este registro.',
  ID_RETIRED: 'Este registro foi excluído definitivamente; use uma cópia com novo ID.',
  WORKSPACE_MISMATCH: 'O registro pertence a outro espaço.',
  PAYLOAD_TOO_LARGE: 'O conteúdo passa do limite de 1 MiB por registro.',
  VALIDATION_ERROR: 'O servidor recusou o conteúdo por validação.',
  LOCAL_BYTES_MISSING: 'Os bytes do áudio não estão mais neste dispositivo; importe o arquivo de novo.',
  ASSET_CHECKSUM_MISMATCH: 'O servidor recebeu bytes diferentes do arquivo original.',
  ASSET_SIZE_MISMATCH: 'O servidor recebeu um arquivo de outro tamanho.',
  ASSET_TYPE_UNSUPPORTED: 'O servidor não aceitou o formato do áudio.',
  IDEMPOTENCY_KEY_REUSED: 'O servidor já tinha esta tentativa com outro conteúdo.',
  DEVICE_EXPIRED: 'Este dispositivo ficou muito tempo sem sincronizar.',
};

/** Motivo curto de a fila estar parada, quando o envio não depende só de conexão. */
export const SUSPENDED_TEXT: Partial<Record<ConnectionState, string>> = {
  revoked: 'Envio suspenso: acesso revogado',
  'read-only': 'Não enviado: seu papel não permite publicar',
  'identity-mismatch': 'Envio suspenso: a conta conectada é outra',
  'auth-required': 'Envio suspenso: entre de novo para enviar',
};

/** Resumo do estado: "conectado" não é o mesmo que "tudo confirmado". */
export function connectionSummary(connection: ConnectionState, pending: number, conflicts: number): { short: string; long: string } {
  if (connection !== 'idle' || (pending === 0 && conflicts === 0)) return CONNECTION_TEXT[connection];
  if (conflicts > 0) {
    return { short: 'Conectado, com conflito', long: `Conectado. ${conflicts === 1 ? 'Há 1 conflito' : `Há ${conflicts} conflitos`} aguardando a sua decisão; nada desse conteúdo é enviado até lá.` };
  }
  return { short: 'Conectado, com pendências', long: `Conectado. ${pending === 1 ? '1 alteração ainda não foi confirmada' : `${pending} alterações ainda não foram confirmadas`} pelo servidor; veja o motivo abaixo.` };
}

export const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
