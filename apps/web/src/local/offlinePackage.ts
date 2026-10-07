import { FONT_PACK_VERSION, orderedSetlistItems, type FontPackManifest, type IsoInstant, type Uuid } from '@louvorvisual/domain';
import { prepareSnapshot } from '@louvorvisual/presentation';
import { assetPresent, getAsset, readAssetBlob, verifyAsset, type AssetCheck, type AudioProbe } from './assets';
import type { LocalDatabase } from './db';
import { getEntityState } from './repository';
import type { OfflinePackageItem, OfflinePackageRow, PackageProblem, ReadyPackage } from './schema';
import { getSetlist } from './setlists';

/** Estados do pacote (planejamento/08). `preparing` existe só na tela, enquanto a preparação roda. */
export type OfflinePackageState = 'notPrepared' | 'preparing' | 'ready' | 'stale' | 'failed';

export type StaleReason =
  | { code: 'setlist-changed' }
  | { code: 'setlist-missing' }
  | { code: 'font-pack-changed' }
  | { code: 'song-changed' | 'arrangement-changed' | 'audio-missing'; itemId: Uuid; subject: string };

export type PackageStatus = {
  state: Exclude<OfflinePackageState, 'preparing'>;
  preparedAt: IsoInstant | null;
  /** Por que a última tentativa não ficou pronta. */
  problems: PackageProblem[];
  /** O que mudou desde a preparação que está guardada. */
  staleReasons: StaleReason[];
  /** Existe uma cópia preparada anterior que continua utilizável. */
  usableCopy: boolean;
  items: number;
};

export type PackageDeps = {
  /** Lê o arquivo da fonte de onde o aplicativo o serve e confere o hash do manifesto. */
  verifyFont: (file: string, sha256: string) => Promise<boolean>;
  probe: AudioProbe;
  fonts: FontPackManifest;
  now: () => IsoInstant;
  newId: () => Uuid;
  /** Passos concluídos de um total conhecido; cada passo é uma conferência real. */
  onProgress?: (done: number, total: number, label: string) => void;
};

const AUDIO_PROBLEM: Record<Exclude<AssetCheck, 'ok'>, 'audio-missing' | 'audio-corrupted'> = { missing: 'audio-missing', corrupted: 'audio-corrupted' };

/**
 * Prepara um repertório para uso offline: resolve cada item na revisão atual,
 * confere as dependências transitivas (louvor, arranjo, tema, arquivos de
 * fonte, bytes e leitura da faixa escolhida) e só grava `ready` se nenhuma
 * conferência falhar. Uma falha registra o que falta e mantém a cópia pronta
 * anterior, se houver.
 */
export async function prepareOfflinePackage(db: LocalDatabase, setlistId: Uuid, deps: PackageDeps): Promise<PackageStatus> {
  const setlist = await getSetlist(db, setlistId);
  if (!setlist) return offlinePackageStatus(db, setlistId);
  const setlistGeneration = (await getEntityState(db, 'setlist', setlistId))?.localGeneration ?? 0;
  const ordered = orderedSetlistItems(setlist.items);
  const problems: PackageProblem[] = [];
  const items: OfflinePackageItem[] = [];
  const fontIds = new Set<string>();
  const checkedAudio = new Map<string, AssetCheck | 'unplayable'>();
  if (ordered.length === 0) problems.push({ code: 'empty' });

  // Um passo por item e, depois, um por arquivo de fonte exigido.
  let done = 0;
  let total = ordered.length;
  const step = (label: string) => deps.onProgress?.(++done, Math.max(total, done), label);

  for (const item of ordered) {
    const base = { itemId: item.id, arrangementId: item.arrangementId };
    const found = await db.arrangements.get(item.arrangementId);
    const arrangement = found && found.deletedAt === null ? found : null;
    if (!arrangement) {
      problems.push({ code: 'arrangement-missing', ...base });
      step('arranjo ausente');
      continue;
    }
    const foundSong = await db.songs.get(arrangement.songId);
    const song = foundSong && foundSong.deletedAt === null ? foundSong : null;
    if (!song) {
      problems.push({ code: 'song-missing', ...base });
      step('louvor ausente');
      continue;
    }
    const subject = { ...base, songId: song.id, subject: song.title };

    // Só a faixa escolhida é exigida; as demais associações podem faltar.
    const binding = arrangement.audioBindings.find((candidate) => candidate.id === arrangement.selectedAudioBindingId) ?? null;
    const asset = binding ? await getAsset(db, binding.assetId) : null;
    let audioOk = binding === null;
    if (binding && !asset) problems.push({ code: 'asset-missing', ...subject });
    if (binding && asset) {
      let check = checkedAudio.get(asset.sha256);
      if (check === undefined) {
        check = await verifyAsset(db, asset, deps.now());
        if (check === 'ok') {
          const blob = await readAssetBlob(db, asset.workspaceId, asset.sha256);
          const duration = blob ? await deps.probe(blob).catch(() => null) : null;
          if (duration === null) check = 'unplayable';
        }
        checkedAudio.set(asset.sha256, check);
      }
      if (check === 'ok') audioOk = true;
      else problems.push({ code: check === 'unplayable' ? 'audio-unplayable' : AUDIO_PROBLEM[check], ...subject, filename: asset.filename });
    }

    const [songState, arrangementState] = await Promise.all([getEntityState(db, 'song', song.id), getEntityState(db, 'arrangement', arrangement.id)]);
    const prepared = prepareSnapshot({
      id: deps.newId(),
      now: deps.now(),
      song,
      arrangement,
      songGeneration: songState?.localGeneration ?? 0,
      arrangementGeneration: arrangementState?.localGeneration ?? 0,
      audio: binding && asset && audioOk ? { binding, asset } : null,
    });
    if (!prepared.ok) {
      problems.push({ code: 'snapshot-invalid', ...subject });
      step(song.title);
      continue;
    }
    fontIds.add(prepared.snapshot.fontId);
    items.push({
      itemId: item.id,
      arrangementId: arrangement.id,
      songId: song.id,
      title: song.title,
      arrangementName: arrangement.name,
      songGeneration: prepared.snapshot.song.localGeneration,
      arrangementGeneration: prepared.snapshot.arrangement.localGeneration,
      snapshot: prepared.snapshot,
      baseArrangement: arrangement,
      audio: binding && asset && audioOk ? { bindingId: binding.id, assetId: asset.id, sha256: asset.sha256, byteSize: asset.byteSize, filename: asset.filename } : null,
    });
    step(song.title);
  }

  // Fontes exigidas pelo repertório, nos dois pesos: o operador pode alternar ao vivo.
  const faces = deps.fonts.fonts.filter((font) => fontIds.has(font.fontId)).flatMap((font) => font.faces.map((face) => ({ file: face.file, sha256: face.sha256, family: font.family })));
  total += faces.length;
  const fonts: ReadyPackage['fonts'] = [];
  for (const face of faces) {
    const intact = await deps.verifyFont(face.file, face.sha256).catch(() => false);
    if (intact) fonts.push({ file: face.file, sha256: face.sha256 });
    else problems.push({ code: 'font-missing', subject: face.family, filename: face.file });
    step(face.file);
  }

  const at = deps.now();
  const previous = await db.offlinePackages.get(setlistId);
  const row: OfflinePackageRow =
    problems.length === 0
      ? { setlistId, workspaceId: setlist.workspaceId, ready: { preparedAt: at, setlistGeneration, fontPackVersion: deps.fonts.version, fonts, items }, lastAttempt: { at, ok: true, problems: [] } }
      : { setlistId, workspaceId: setlist.workspaceId, ready: previous?.ready ?? null, lastAttempt: { at, ok: false, problems } };
  await db.offlinePackages.put(row);
  return offlinePackageStatus(db, setlistId);
}

/** O que mudou desde a preparação guardada. Conferência barata: gerações e presença dos bytes. */
async function staleReasons(db: LocalDatabase, setlistId: Uuid, ready: ReadyPackage): Promise<StaleReason[]> {
  const reasons: StaleReason[] = [];
  const setlist = await getSetlist(db, setlistId);
  if (!setlist) return [{ code: 'setlist-missing' }];
  if (((await getEntityState(db, 'setlist', setlistId))?.localGeneration ?? 0) !== ready.setlistGeneration) reasons.push({ code: 'setlist-changed' });
  if (ready.fontPackVersion !== FONT_PACK_VERSION) reasons.push({ code: 'font-pack-changed' });
  for (const item of ready.items) {
    const subject = { itemId: item.itemId, subject: item.title };
    const [song, arrangement] = await Promise.all([getEntityState(db, 'song', item.songId), getEntityState(db, 'arrangement', item.arrangementId)]);
    if ((song?.localGeneration ?? 0) !== item.songGeneration) reasons.push({ code: 'song-changed', ...subject });
    if ((arrangement?.localGeneration ?? 0) !== item.arrangementGeneration) reasons.push({ code: 'arrangement-changed', ...subject });
    if (item.audio && !(await assetPresent(db, { workspaceId: item.snapshot.workspaceId, sha256: item.audio.sha256, byteSize: item.audio.byteSize }))) {
      reasons.push({ code: 'audio-missing', ...subject });
    }
  }
  return reasons;
}

export async function offlinePackageStatus(db: LocalDatabase, setlistId: Uuid): Promise<PackageStatus> {
  const row = await db.offlinePackages.get(setlistId);
  const ready = row?.ready ?? null;
  const base = { preparedAt: ready?.preparedAt ?? null, usableCopy: ready !== null, items: ready?.items.length ?? 0 };
  if (!row) return { state: 'notPrepared', problems: [], staleReasons: [], ...base };
  const reasons = ready ? await staleReasons(db, setlistId, ready) : [];
  if (row.lastAttempt && !row.lastAttempt.ok) return { state: 'failed', problems: row.lastAttempt.problems, staleReasons: reasons, ...base };
  if (!ready) return { state: 'notPrepared', problems: [], staleReasons: [], ...base };
  return { state: reasons.length === 0 ? 'ready' : 'stale', problems: [], staleReasons: reasons, ...base };
}

/**
 * Cópia preparada de um item, se o repertório tem uma preparação concluída.
 * `newer` avisa que a biblioteca já tem revisão mais recente deste louvor.
 */
export async function preparedItem(db: LocalDatabase, setlistId: Uuid, itemId: Uuid): Promise<{ item: OfflinePackageItem; newer: boolean } | null> {
  const ready = (await db.offlinePackages.get(setlistId))?.ready;
  const item = ready?.items.find((candidate) => candidate.itemId === itemId);
  if (!item) return null;
  const [song, arrangement] = await Promise.all([getEntityState(db, 'song', item.songId), getEntityState(db, 'arrangement', item.arrangementId)]);
  return { item, newer: (song?.localGeneration ?? 0) !== item.songGeneration || (arrangement?.localGeneration ?? 0) !== item.arrangementGeneration };
}
