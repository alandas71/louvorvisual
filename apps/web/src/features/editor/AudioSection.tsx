'use client';

import {
  AUDIO_KINDS,
  deriveCues,
  formatTimerSeconds,
  linkIssues,
  type Arrangement,
  type ArrangementStructure,
  type Asset,
  type AudioBinding,
  type AudioKind,
  type AudioPolicy,
  type LinkIssue,
  type Uuid,
} from '@louvorvisual/domain';
import { useEffect, useRef, useState } from 'react';
import { AudioImport, type ImportStatus } from '@/components/ui/AudioImport';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { assetPresent, getAsset, importAudioFile, readAssetBlob, type ImportProgress, type LocalSession } from '@/local';
import { estimateFreeSpace, formatBytes, formatClock, probeAudio } from '../audio/htmlTransport';

const KIND_TEXT: Record<AudioKind, { title: string; importLabel: string; help: string }> = {
  original: { title: 'Áudio original', importLabel: 'Importar o áudio original', help: 'A gravação com voz, para ensaio ou para tocar junto.' },
  playback: { title: 'Playback', importLabel: 'Importar o playback', help: 'A base instrumental para a igreja cantar.' },
};

const PHASE_TEXT: Record<ImportProgress['phase'], string> = {
  reading: 'Lendo o arquivo e calculando a identidade…',
  checking: 'Conferindo se o navegador reproduz o áudio…',
  storing: 'Gravando neste dispositivo…',
  verifying: 'Conferindo o que foi gravado…',
};

const LINK_ISSUE_TEXT: Record<LinkIssue, string> = {
  'no-occurrences': 'O arranjo não tem slides.',
  'missing-duration': 'Todos os slides precisam de tempo para vincular a faixa.',
  'missing-cue': 'Faltam intervalos para alguns slides.',
  'cues-out-of-order': 'Os intervalos não estão em ordem crescente.',
  'negative-offset': 'O ponto de partida não pode ser negativo.',
  'unknown-track-duration': 'A duração da gravação é desconhecida.',
  'beyond-track-end': 'Os tempos dos slides passam do fim da gravação.',
};

type AssetInfo = { asset: Asset | null; present: boolean };

type AudioSectionProps = {
  session: LocalSession;
  arrangement: Arrangement;
  /** Aplica uma mudança nas associações de áudio, com histórico e gravação. */
  onChange: (change: (structure: ArrangementStructure) => ArrangementStructure) => void;
};

/**
 * Áudio do arranjo: áudio original e playback importados para este
 * dispositivo, a faixa ativa da apresentação e, por faixa, volume, ponto de
 * partida e política (independente ou vinculada aos slides).
 */
export function AudioSection({ session, arrangement, onChange }: AudioSectionProps) {
  const [info, setInfo] = useState<Record<Uuid, AssetInfo>>({});
  const assetIds = arrangement.audioBindings.map((binding) => binding.assetId).join(',');

  useEffect(() => {
    let current = true;
    void (async () => {
      const entries = await Promise.all(
        assetIds
          .split(',')
          .filter(Boolean)
          .map(async (assetId): Promise<[Uuid, AssetInfo]> => {
            const asset = await getAsset(session.db, assetId);
            return [assetId, { asset, present: asset ? await assetPresent(session.db, asset) : false }];
          }),
      );
      if (current) setInfo(Object.fromEntries(entries));
    })();
    return () => {
      current = false;
    };
  }, [session, assetIds]);

  async function importFile(kind: AudioKind, file: File, onProgress: (status: ImportStatus) => void) {
    const context = session.context();
    const { asset } = await importAudioFile(session.db, {
      file,
      filename: file.name,
      kind,
      profileId: session.profile.profileId,
      workspaceId: session.profile.workspaceId,
      now: () => new Date().toISOString(),
      newId: context.newId,
      probe: probeAudio,
      freeSpace: estimateFreeSpace,
      onProgress: (progress) => onProgress({ label: PHASE_TEXT[progress.phase], loadedBytes: progress.loadedBytes, totalBytes: progress.totalBytes }),
    });
    // Com áudio guardado, vale pedir ao navegador que não descarte os dados por falta de espaço.
    void navigator.storage?.persist?.().catch(() => false);
    setInfo((previous) => ({ ...previous, [asset.id]: { asset, present: true } }));
    onChange((structure) => {
      const existing = structure.audioBindings.find((binding) => binding.kind === kind);
      // Trocar o arquivo mantém volume e política; os intervalos são recalculados para a nova gravação.
      const binding: AudioBinding = existing
        ? { ...existing, assetId: asset.id, cues: [], cuesVersion: existing.cuesVersion + 1 }
        : { id: context.newId(), assetId: asset.id, kind, policy: 'independent', volume: 1, offsetMs: 0, cuesVersion: 0, cues: [] };
      const audioBindings = existing ? structure.audioBindings.map((item) => (item.id === existing.id ? binding : item)) : [...structure.audioBindings, binding];
      return { ...structure, audioBindings, selectedAudioBindingId: structure.selectedAudioBindingId ?? binding.id };
    });
  }

  const update = (bindingId: Uuid, fields: Partial<Pick<AudioBinding, 'volume' | 'policy' | 'offsetMs'>>) =>
    onChange((structure) => ({ ...structure, audioBindings: structure.audioBindings.map((binding) => (binding.id === bindingId ? { ...binding, ...fields } : binding)) }));

  const remove = (bindingId: Uuid) =>
    onChange((structure) => ({
      ...structure,
      audioBindings: structure.audioBindings.filter((binding) => binding.id !== bindingId),
      selectedAudioBindingId: structure.selectedAudioBindingId === bindingId ? null : structure.selectedAudioBindingId,
    }));

  return (
    <section aria-labelledby="audio" className="flex flex-col gap-4" data-testid="audio-section">
      <div>
        <h2 id="audio" className="text-lg font-semibold">
          Áudio
        </h2>
        <p className="text-sm text-muted">Os arquivos ficam guardados neste dispositivo e tocam sem conexão. Na apresentação toca uma faixa por vez.</p>
      </div>

      {arrangement.audioBindings.length > 0 && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="active-track">
          <legend className="mb-1 text-xs font-semibold uppercase text-muted">Faixa ativa na apresentação</legend>
          <label className="flex cursor-pointer items-center gap-1">
            <input type="radio" name="faixa-ativa" className="accent-accent" checked={arrangement.selectedAudioBindingId === null} onChange={() => onChange((structure) => ({ ...structure, selectedAudioBindingId: null }))} />
            Sem áudio
          </label>
          {arrangement.audioBindings.map((binding) => (
            <label key={binding.id} className="flex cursor-pointer items-center gap-1">
              <input type="radio" name="faixa-ativa" className="accent-accent" checked={arrangement.selectedAudioBindingId === binding.id} onChange={() => onChange((structure) => ({ ...structure, selectedAudioBindingId: binding.id }))} />
              {KIND_TEXT[binding.kind].title}
            </label>
          ))}
        </fieldset>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {AUDIO_KINDS.map((kind) => {
          const binding = arrangement.audioBindings.find((item) => item.kind === kind);
          return (
            <div key={kind} className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4" data-testid={`audio-${kind}`} data-state={binding ? 'bound' : 'empty'}>
              <div>
                <h3 className="font-semibold">{KIND_TEXT[kind].title}</h3>
                <p className="text-xs text-muted">{KIND_TEXT[kind].help}</p>
              </div>
              {binding ? (
                <Track session={session} arrangement={arrangement} binding={binding} info={info[binding.assetId]} onUpdate={(fields) => update(binding.id, fields)} onRemove={() => remove(binding.id)} />
              ) : null}
              <AudioImport label={binding ? 'Trocar o arquivo desta faixa' : KIND_TEXT[kind].importLabel} testId={`audio-import-${kind}`} onImport={(file, onProgress) => importFile(kind, file, onProgress)} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

type TrackProps = {
  session: LocalSession;
  arrangement: Arrangement;
  binding: AudioBinding;
  info: AssetInfo | undefined;
  onUpdate: (fields: Partial<Pick<AudioBinding, 'volume' | 'policy' | 'offsetMs'>>) => void;
  onRemove: () => void;
};

function Track({ session, arrangement, binding, info, onUpdate, onRemove }: TrackProps) {
  const [offset, setOffset] = useState(formatTimerSeconds(binding.offsetMs));
  const asset = info?.asset ?? null;
  const duration = asset?.durationMs ?? null;
  // O que impediria (ou impede) o vínculo com os tempos atuais dos slides.
  const derived = deriveCues(arrangement.occurrences, binding.offsetMs);
  const issues = linkIssues(arrangement.occurrences, derived ?? [], duration);
  const total = arrangement.occurrences.reduce((sum, occurrence) => sum + (occurrence.durationMs ?? 0), 0);

  function applyOffset(text: string) {
    setOffset(text);
    const seconds = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(seconds) || seconds < 0) return;
    onUpdate({ offsetMs: Math.round(seconds * 1000) });
  }

  if (info === undefined) return <p className="text-sm text-muted">Conferindo o arquivo…</p>;

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="audio-track" data-policy={binding.policy} data-present={info.present} data-asset-id={binding.assetId}>
      {asset ? (
        <p>
          <span className="font-semibold">{asset.filename}</span>
          <br />
          <span className="text-muted">
            {formatBytes(asset.byteSize)} · <span data-testid="audio-duration" data-duration-ms={asset.durationMs ?? ''}>{duration === null ? 'duração desconhecida' : formatClock(duration)}</span>
          </span>
        </p>
      ) : (
        <p role="alert" className="text-danger">
          O registro deste arquivo não existe mais neste dispositivo.
        </p>
      )}
      <p data-testid="audio-availability" className={info.present ? 'text-muted' : 'text-danger'} role={info.present ? undefined : 'alert'}>
        {info.present ? '✓ Disponível neste dispositivo' : '⚠ O arquivo não está neste dispositivo. Importe-o de novo para usar a faixa.'}
      </p>

      {info.present && asset && <Listen session={session} asset={asset} />}

      <div>
        <Label htmlFor={`volume-${binding.id}`}>Volume inicial · {Math.round(binding.volume * 100)}%</Label>
        <input id={`volume-${binding.id}`} type="range" className="w-full accent-accent" min={0} max={1} step={0.05} value={binding.volume} onChange={(event) => onUpdate({ volume: Number(event.target.value) })} />
      </div>
      <div>
        <Label htmlFor={`partida-${binding.id}`}>Ponto de partida na gravação, em segundos</Label>
        <Input id={`partida-${binding.id}`} inputMode="decimal" value={offset} onChange={(event) => applyOffset(event.target.value)} className="px-2 py-1.5" />
        <p className="mt-1 text-xs text-muted">Iniciar no primeiro slide toca a partir daqui. Para tocar a introdução inteira, deixe zero e crie um slide instrumental.</p>
      </div>
      <div>
        <Label htmlFor={`politica-${binding.id}`}>Relação com os slides</Label>
        <Select id={`politica-${binding.id}`} value={binding.policy} onChange={(event) => onUpdate({ policy: event.target.value as AudioPolicy })} className="py-1.5">
          <option value="independent">Independente: trocar de slide não mexe na faixa</option>
          <option value="linked" disabled={binding.policy !== 'linked' && issues.length > 0}>
            Vinculada: slides e faixa seguem os mesmos intervalos
          </option>
        </Select>
        {issues.length > 0 ? (
          <div role={binding.policy === 'linked' ? 'alert' : undefined} className={binding.policy === 'linked' ? 'mt-1 text-xs text-danger' : 'mt-1 text-xs text-muted'} data-testid="link-issues">
            {binding.policy === 'linked' ? 'O vínculo está impedido e a faixa tocará como independente até corrigir: ' : 'Para vincular: '}
            {issues.map((issue) => LINK_ISSUE_TEXT[issue]).join(' ')}
            {issues.includes('beyond-track-end') && duration !== null && ` Terminam em ${formatClock(binding.offsetMs + total)}; a gravação tem ${formatClock(duration)}.`}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted" data-testid="link-ok">
            {binding.policy === 'linked'
              ? `Intervalos de ${formatClock(binding.offsetMs)} a ${formatClock(binding.offsetMs + total)} da gravação, calculados pelos tempos dos slides.`
              : 'Os tempos dos slides cabem na gravação: a faixa pode ser vinculada.'}
          </p>
        )}
      </div>
      <button type="button" className={buttonClass('danger', 'sm', 'self-start')} onClick={onRemove}>
        Remover esta faixa do arranjo
      </button>
    </div>
  );
}

/** Teste audível no editor: toca os bytes guardados, por uma URL criada só enquanto o player está aberto. */
function Listen({ session, asset }: { session: LocalSession; asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const created = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (created.current) URL.revokeObjectURL(created.current);
    },
    [],
  );

  async function open() {
    const blob = await readAssetBlob(session.db, asset.workspaceId, asset.sha256);
    if (!blob) {
      setFailed(true);
      return;
    }
    created.current = URL.createObjectURL(blob);
    setUrl(created.current);
  }

  if (failed) return <p role="alert" className="text-xs text-danger">Não foi possível abrir o arquivo guardado.</p>;
  if (!url) {
    return (
      <button type="button" className={buttonClass('secondary', 'sm', 'self-start')} onClick={() => void open()}>
        ▶ Ouvir
      </button>
    );
  }
  return <audio controls src={url} className="w-full" data-testid="audio-listen" onError={() => setFailed(true)} />;
}
