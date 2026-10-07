import type { CommandFailure, SaveField, SnapshotIssue, SnapshotWarning } from '@louvorvisual/presentation';

export const SNAPSHOT_WARNING_TEXT: Record<SnapshotWarning, string> = {
  'theme-unavailable': 'O tema gravado neste arranjo não está disponível neste dispositivo. A apresentação usa Preto acessível.',
  'font-unavailable': 'A fonte gravada neste arranjo não faz parte deste aplicativo. A apresentação usa Inter.',
  'font-pack-mismatch': 'O arranjo foi gravado com outra versão do pacote de fontes; confira as quebras de linha.',
  'audio-link-unavailable':
    'A faixa não pôde ser vinculada aos slides: falta tempo em algum slide ou os tempos passam do fim da gravação. Ela toca como independente; corrija os tempos no editor para vincular.',
};

export const SNAPSHOT_ISSUE_TEXT: Record<SnapshotIssue, string> = {
  'empty-sequence': 'Este arranjo não tem slides. Volte ao editor e gere os slides a partir da letra.',
  'song-mismatch': 'O arranjo não pertence a este louvor.',
  deleted: 'Este louvor foi excluído.',
};

export const COMMAND_FAILURE_TEXT: Record<CommandFailure, string> = {
  'invalid-state': 'Esta ação não vale no estado atual da apresentação.',
  'unknown-occurrence': 'Este slide não faz parte da sessão.',
  'invalid-value': 'Valor fora do permitido; nada foi alterado.',
  'at-limit': 'Já está no limite.',
  'nothing-to-undo': 'Não há ajuste para desfazer.',
  'no-transport': 'Este slide não tem tempo no automático: use avançar ou voltar.',
  'no-audio': 'Esta sessão não tem faixa de áudio.',
  'audio-linked': 'Com a faixa vinculada, o tempo dos slides só muda pela revisão em pausa, e o play/pause é o da apresentação.',
  'requires-pause': 'Pause a apresentação para aplicar os tempos revisados.',
  'invalid-timing': 'Os tempos revisados não cabem na gravação. Nada foi alterado.',
};

export const AUDIO_KIND_TEXT = { original: 'Áudio original', playback: 'Playback' } as const;
export const AUDIO_POLICY_TEXT = { independent: 'independente dos slides', linked: 'vinculada aos slides' } as const;

export const SAVE_FIELD_TEXT: Record<SaveField['field'], string> = {
  theme: 'tema',
  font: 'fonte',
  fontSizePx: 'tamanho da letra',
  fontWeight: 'peso da letra',
  textAlign: 'alinhamento',
  verticalAlign: 'posição vertical',
  lineHeight: 'entrelinha',
  text: 'texto',
  durationMs: 'tempo',
};

export function formatSeconds(ms: number): string {
  return (ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}
