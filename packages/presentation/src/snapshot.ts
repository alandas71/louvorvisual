import {
  bundledFont,
  cuesInSequence,
  linkIssues,
  FONT_PACK_VERSION,
  isBundledFontId,
  isThemePresetId,
  RECOVERY_FONT_ID,
  SAFETY_THEME_PRESET_ID,
  SYSTEM_FALLBACK_STACK,
  themePreset,
  type Arrangement,
  type Asset,
  type AudioBinding,
  type AudioCue,
  type AudioKind,
  type AudioPolicy,
  type BundledFontId,
  type IsoInstant,
  type LinkIssue,
  type OccurrenceVisualKind,
  type PresentationMode,
  type Revision,
  type Song,
  type ThemePreset,
  type ThemePresetId,
  type ThemeStyle,
  type Uuid,
} from '@louvorvisual/domain';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export type ArrangementVisual = {
  preset: ThemePreset;
  style: ThemeStyle;
  fontId: BundledFontId;
  /** A fonte foi escolhida manualmente; trocar de tema não a substitui. */
  fontChosen: boolean;
  /** O tema ou a fonte gravados não puderam ser resolvidos neste aplicativo. */
  themeUnavailable: boolean;
  fontUnavailable: boolean;
};

/**
 * Aparência efetiva de um arranjo: tema referenciado, ajustes do arranjo e
 * fonte manual. Tema indisponível cai no tema de segurança (planejamento/07);
 * fonte desconhecida cai na fonte de recuperação. Quem chama avisa o operador.
 */
export function resolveArrangementVisual(arrangement: Pick<Arrangement, 'themeRef' | 'themeOverrides' | 'fontId'>): ArrangementVisual {
  const { themeRef, fontId } = arrangement;
  const known = themeRef.kind === 'builtin' && isThemePresetId(themeRef.presetId);
  const preset = themePreset(known ? (themeRef.presetId as ThemePresetId) : SAFETY_THEME_PRESET_ID);
  const fontUnavailable = fontId !== null && !isBundledFontId(fontId);
  return {
    preset,
    // A paleta de um tema indisponível não é combinada com a do tema de segurança.
    style: known ? { ...preset.style, ...(arrangement.themeOverrides ?? {}) } : preset.style,
    fontId: fontId === null ? preset.initialFontId : isBundledFontId(fontId) ? fontId : RECOVERY_FONT_ID,
    fontChosen: fontId !== null,
    themeUnavailable: !known,
    fontUnavailable,
  };
}

/** Pilha CSS da família embutida, com a reserva de sistema explícita. */
export function fontStack(fontId: BundledFontId): string {
  return `"${bundledFont(fontId).family}", ${SYSTEM_FALLBACK_STACK}`;
}

export type SnapshotOccurrence = {
  id: Uuid;
  label: string;
  text: string;
  durationMs: number | null;
  visualKind: OccurrenceVisualKind;
  /** Estilo já resolvido: tema, ajustes do arranjo e ajustes da ocorrência. */
  style: ThemeStyle;
};

export type SnapshotSource = {
  id: Uuid;
  serverRevision: Revision | null;
  /** Geração local do documento quando a sessão foi preparada. */
  localGeneration: number;
};

/**
 * Faixa ativa da sessão. A identidade é o arquivo (`assetId`) e seus bytes
 * (`sha256`): o player abre exatamente os bytes conferidos na preparação.
 */
export type SnapshotAudio = {
  bindingId: Uuid;
  assetId: Uuid;
  sha256: string;
  byteSize: number;
  filename: string;
  kind: AudioKind;
  /** Política em vigor: uma faixa gravada como vinculada só chega assim com intervalos válidos. */
  policy: AudioPolicy;
  volume: number;
  offsetMs: number;
  durationMs: number;
  /** Intervalos na ordem da sequência; completos quando a política é vinculada. */
  cues: AudioCue[];
};

/**
 * Base estável de uma sessão: tudo o que a apresentação precisa, copiado no
 * momento da preparação. Edições e sincronização posteriores não a alteram.
 */
export type SessionSnapshot = {
  id: Uuid;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  workspaceId: Uuid;
  createdAt: IsoInstant;
  /** `notes` são privadas do operador: ficam no snapshot e nunca entram no estado visual enviado à saída. */
  song: SnapshotSource & { title: string; artist: string | null; notes: string };
  arrangement: SnapshotSource & { name: string; defaultMode: PresentationMode; introDurationMs?: number };
  themePresetId: ThemePresetId;
  fontId: BundledFontId;
  fontChosen: boolean;
  fontPackVersion: string;
  occurrences: SnapshotOccurrence[];
  /** Faixa escolhida para a sessão, com os bytes locais já conferidos; `null` sem áudio. */
  audio: SnapshotAudio | null;
};

export type SnapshotWarning = 'theme-unavailable' | 'font-unavailable' | 'font-pack-mismatch' | 'audio-link-unavailable';
export type SnapshotIssue = 'empty-sequence' | 'song-mismatch' | 'deleted';

export type PrepareInput = {
  id: Uuid;
  now: IsoInstant;
  song: Song;
  arrangement: Arrangement;
  songGeneration: number;
  arrangementGeneration: number;
  /** Faixa escolhida e seu arquivo, já disponível e íntegro neste dispositivo. */
  audio?: { binding: AudioBinding; asset: Asset } | null;
};

export type PreparedAudio = { audio: SnapshotAudio; linkIssues: LinkIssue[] };

/**
 * Resolve a faixa para a sessão. Vínculo com tempo ausente, intervalo ausente
 * ou último intervalo além do fim da gravação não é aceito: a faixa segue como
 * independente e `linkIssues` diz o que corrigir.
 */
export function prepareAudio(binding: AudioBinding, asset: Asset, occurrences: readonly SnapshotOccurrence[]): PreparedAudio | null {
  if (asset.durationMs === null || asset.durationMs <= 0) return null;
  const sequence = occurrences.map((occurrence, order) => ({ id: occurrence.id, order, durationMs: occurrence.durationMs }));
  const issues = binding.policy === 'linked' ? linkIssues(sequence, binding.cues, asset.durationMs) : [];
  const linked = binding.policy === 'linked' && issues.length === 0;
  return {
    linkIssues: issues,
    audio: {
      bindingId: binding.id,
      assetId: asset.id,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
      filename: asset.filename,
      kind: binding.kind,
      policy: linked ? 'linked' : 'independent',
      volume: binding.volume,
      offsetMs: Math.max(0, binding.offsetMs),
      durationMs: asset.durationMs,
      cues: linked ? (cuesInSequence(sequence.map((item) => item.id), binding.cues) as AudioCue[]) : [],
    },
  };
}

export type PrepareResult =
  | { ok: true; snapshot: SessionSnapshot; warnings: SnapshotWarning[] }
  | { ok: false; issues: SnapshotIssue[] };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** "Preparar": valida os documentos e produz a base da sessão. */
export function prepareSnapshot(input: PrepareInput): PrepareResult {
  const { song, arrangement } = input;
  const issues: SnapshotIssue[] = [];
  if (arrangement.songId !== song.id) issues.push('song-mismatch');
  if (song.deletedAt !== null || arrangement.deletedAt !== null) issues.push('deleted');
  if (arrangement.occurrences.length === 0) issues.push('empty-sequence');
  if (issues.length > 0) return { ok: false, issues };

  const visual = resolveArrangementVisual(arrangement);
  const warnings: SnapshotWarning[] = [];
  if (visual.themeUnavailable) warnings.push('theme-unavailable');
  if (visual.fontUnavailable) warnings.push('font-unavailable');
  if (arrangement.fontPackVersion !== FONT_PACK_VERSION) warnings.push('font-pack-mismatch');

  const occurrences = [...arrangement.occurrences]
    .sort((a, b) => a.order - b.order)
    .map((occurrence): SnapshotOccurrence => ({
      id: occurrence.id,
      label: occurrence.label,
      text: occurrence.text,
      durationMs: occurrence.durationMs,
      visualKind: occurrence.visualKind,
      style: { ...visual.style, ...(visual.themeUnavailable ? {} : (occurrence.visualOverrides ?? {})) },
    }));

  const prepared = input.audio ? prepareAudio(input.audio.binding, input.audio.asset, occurrences) : null;
  if (prepared && prepared.linkIssues.length > 0) warnings.push('audio-link-unavailable');

  const snapshot: SessionSnapshot = {
    id: input.id,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    workspaceId: arrangement.workspaceId,
    createdAt: input.now,
    song: { id: song.id, serverRevision: song.serverRevision, localGeneration: input.songGeneration, title: song.title, artist: song.artist, notes: song.notes },
    arrangement: {
      id: arrangement.id,
      serverRevision: arrangement.serverRevision,
      localGeneration: input.arrangementGeneration,
      name: arrangement.name,
      defaultMode: arrangement.defaultMode,
      ...(typeof arrangement.introDurationMs === 'number' ? { introDurationMs: arrangement.introDurationMs } : {}),
    },
    themePresetId: visual.preset.presetId,
    fontId: visual.fontId,
    fontChosen: visual.fontChosen,
    fontPackVersion: FONT_PACK_VERSION,
    occurrences,
    audio: prepared?.audio ?? null,
  };
  // Cópia profunda: nada do documento original fica compartilhado com a sessão.
  return { ok: true, snapshot: clone(snapshot), warnings };
}

/** Problemas de um snapshot lido do armazenamento antes de recuperar a sessão. */
export function snapshotIssues(snapshot: SessionSnapshot): SnapshotIssue[] {
  return snapshot.occurrences.length === 0 ? ['empty-sequence'] : [];
}
