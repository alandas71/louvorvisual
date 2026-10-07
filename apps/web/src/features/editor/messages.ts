import type { EditErrorCode, EditReviewCode, SectionKind } from '@louvorvisual/domain';

export const SECTION_KIND_LABEL: Record<SectionKind, string> = {
  verse: 'Estrofe',
  chorus: 'Refrão',
  bridge: 'Ponte',
  intro: 'Introdução',
  instrumental: 'Instrumental',
  unknown: 'A classificar',
};

export const EDIT_ERROR_TEXT: Record<EditErrorCode, string> = {
  'unknown-occurrence': 'Este slide não existe mais. Nada foi alterado.',
  'invalid-split-point': 'Escolha uma quebra entre duas linhas do slide.',
  'merge-needs-two': 'Selecione pelo menos dois slides para unir.',
  'not-adjacent': 'Só é possível unir slides vizinhos. Reordene ou selecione uma sequência contínua.',
  'duration-exceeds-limit': 'A soma dos tempos passa de 600 segundos. Ajuste os tempos antes de unir.',
  'invalid-duration': 'O tempo deve ficar entre 0,5 e 600 segundos.',
  'occurrence-limit': 'O arranjo chegou ao limite de 500 slides.',
};

/** Além das revisões do domínio, o editor avisa quando uma faixa perdeu o vínculo. */
export type ReviewCode = EditReviewCode | 'audio-unlinked';

export const EDIT_REVIEW_TEXT: Record<ReviewCode, string> = {
  'split-duration-needs-review': 'O tempo era curto demais para dividir: a segunda parte ficou sem temporizador. Confira os dois slides.',
  'merge-without-timer': 'Um dos slides não tinha tempo, então o slide unido ficou sem temporizador. Configure se quiser.',
  'cues-need-review': 'Os intervalos da faixa vinculada foram recalculados pelos tempos dos slides. Confira antes de apresentar.',
  'audio-unlinked': 'Um slide ficou sem tempo, então a faixa deixou de estar vinculada aos slides: agora ela é independente. Para vincular de novo, dê tempo a todos os slides.',
  'cue-order-mismatch': 'A nova ordem não acompanha as marcações de áudio. Revise as marcações.',
};
