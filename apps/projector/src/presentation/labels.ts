import type { CommandFailure, EngineNotice, SnapshotIssue, SnapshotWarning } from '@louvorvisual/presentation';

export const SNAPSHOT_WARNING_TEXT: Record<SnapshotWarning, string> = {
  'theme-unavailable': 'O tema deste arranjo não está neste aparelho; a apresentação usa Preto acessível.',
  'font-unavailable': 'A fonte deste arranjo não faz parte deste aplicativo; a apresentação usa Inter.',
  'font-pack-mismatch': 'O arranjo foi gravado com outra versão das fontes; confira as quebras de linha.',
  'audio-link-unavailable': 'A faixa não pôde ser vinculada aos slides e toca como independente.',
};

export const SNAPSHOT_ISSUE_TEXT: Record<SnapshotIssue, string> = {
  'empty-sequence': 'Este arranjo não tem slides. Gere os slides no computador e sincronize.',
  'song-mismatch': 'O arranjo não pertence a este louvor.',
  deleted: 'Este louvor foi excluído.',
};

export const COMMAND_FAILURE_TEXT: Record<CommandFailure, string> = {
  'invalid-state': 'Esta ação não vale agora.',
  'unknown-occurrence': 'Este slide não faz parte da sessão.',
  'invalid-value': 'Valor fora do permitido; nada mudou.',
  'at-limit': 'Já está no limite.',
  'nothing-to-undo': 'Não há ajuste para desfazer.',
  'no-transport': 'Este slide não tem tempo: use esquerda e direita.',
  'no-audio': 'Esta sessão não tem áudio.',
  'audio-linked': 'Com a faixa vinculada, o tempo dos slides é revisado no computador.',
  'requires-pause': 'Pause a apresentação antes.',
  'invalid-timing': 'Os tempos não cabem na gravação; nada mudou.',
};

export const NOTICE_TEXT: Record<Exclude<EngineNotice, null>, string> = {
  'suspension-detected': 'O aparelho ficou suspenso. A apresentação voltou em pausa.',
  'autoplay-blocked': 'O aparelho não liberou o áudio. Tente tocar de novo.',
  'seek-failed': 'Não foi possível reposicionar a faixa. A apresentação está em pausa.',
  'audio-stalled': 'A faixa parou de responder.',
  'audio-ended-early': 'A gravação acabou antes dos slides.',
  'audio-failed': 'Não foi possível reproduzir a faixa. Continue sem áudio pelo menu.',
};

export function formatSeconds(ms: number): string {
  return (ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
