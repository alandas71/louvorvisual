'use client';

import { EmptyState, Loading, noticeClass, PageHeader, pillClass, rowClass } from '@/components/ui/PageHeader';
import { addSetlistItem, createSetlist, moveSetlistItem, removeSetlistItem, touch, type Setlist, type SetlistItem, type Uuid } from '@louvorvisual/domain';
import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { PlusIcon, SetlistIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import {
  entityStateKey,
  deleteSetlist,
  getAsset,
  getSetlist,
  listArrangementChoices,
  listSetlists,
  LocalSaveError,
  offlinePackageStatus,
  prepareOfflinePackage,
  resolveSetlist,
  saveDocuments,
  useLocalSession,
  type ArrangementChoice,
  type LocalSession,
  type OfflinePackageState,
  type PackageProblem,
  type PackageStatus,
  type SetlistEntry,
  type StaleReason,
} from '@/local';
import { fontFileUrl, fontPack } from '@/presentation/fontPack';
import { useLibraryVersion } from '@/sync/hooks';
import { acquireEditLease } from '@/sync/leases';
import { formatBytes, probeAudio } from '../audio/htmlTransport';
import { PackageExport } from '../pacotes/PackageExport';
import { PackageImport } from '../pacotes/PackageImport';

const STATE_TEXT: Record<OfflinePackageState, string> = {
  notPrepared: 'Não preparado para uso offline.',
  preparing: 'Preparando e conferindo…',
  ready: '✓ Pronto para uso offline.',
  stale: 'Desatualizado: o repertório ou um arquivo mudou depois da preparação.',
  failed: '⚠ Não está pronto: a última preparação encontrou problemas.',
};

const STATE_TONE = { notPrepared: 'neutral', preparing: 'accent', ready: 'success', stale: 'accent', failed: 'danger' } as const satisfies Record<OfflinePackageState, string>;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const STATE_SHORT: Record<OfflinePackageState, string> = { notPrepared: 'Não preparado', preparing: 'Preparando…', ready: 'Pronto offline', stale: 'Desatualizado', failed: 'Com problemas' };

const PROBLEM_TEXT: Record<PackageProblem['code'], (problem: PackageProblem) => string> = {
  empty: () => 'O repertório não tem louvores.',
  'arrangement-missing': () => 'Um item aponta para um arranjo que não existe mais na biblioteca. Remova o item.',
  'song-missing': () => 'Um item aponta para um louvor que não existe mais na biblioteca. Remova o item.',
  'snapshot-invalid': (problem) => `"${problem.subject}" não pode ser apresentado: o arranjo não tem slides.`,
  'asset-missing': (problem) => `"${problem.subject}": o registro do arquivo de áudio não existe neste dispositivo. Importe o áudio de novo no editor do louvor.`,
  'audio-missing': (problem) => `"${problem.subject}": o arquivo ${problem.filename} não está neste dispositivo. Importe-o de novo no editor do louvor.`,
  'audio-corrupted': (problem) => `"${problem.subject}": o arquivo ${problem.filename} guardado aqui está diferente do original. Importe-o de novo no editor do louvor.`,
  'audio-unplayable': (problem) => `"${problem.subject}": este navegador não conseguiu ler o arquivo ${problem.filename}.`,
  'font-missing': (problem) => `O arquivo ${problem.filename} da fonte ${problem.subject} não está guardado ou está alterado. Abra "Disponível offline" com conexão para reinstalar o aplicativo.`,
};

const STALE_TEXT: Record<StaleReason['code'], (subject: string) => string> = {
  'setlist-changed': () => 'A lista de louvores ou os dados do repertório mudaram.',
  'setlist-missing': () => 'O repertório não existe mais.',
  'font-pack-changed': () => 'O pacote de fontes do aplicativo mudou.',
  'song-changed': (subject) => `"${subject}": o louvor foi editado.`,
  'arrangement-changed': (subject) => `"${subject}": o arranjo foi editado.`,
  'audio-missing': (subject) => `"${subject}": o arquivo de áudio não está mais neste dispositivo.`,
};

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Lê o arquivo da fonte de onde o aplicativo o serve (o cache, quando instalado) e confere o hash do manifesto. */
async function verifyFontFile(file: string, sha256: string): Promise<boolean> {
  const response = await fetch(fontFileUrl(file));
  return response.ok && (await sha256Hex(await response.arrayBuffer())) === sha256;
}

export function SetlistsView() {
  const local = useLocalSession();
  const setlistId = useLocalQuery().get('repertorio');
  if (local.status === 'loading') return <Loading>Abrindo os repertórios…</Loading>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  return setlistId ? <SetlistDetail key={setlistId} session={local.session} setlistId={setlistId} /> : <SetlistList session={local.session} />;
}

function SetlistList({ session }: { session: LocalSession }) {
  const version = useLibraryVersion();
  const [rows, setRows] = useState<{ setlist: Setlist; status: PackageStatus }[] | null>(null);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [imported, setImported] = useState(0);

  useEffect(() => {
    let current = true;
    void listSetlists(session.db, session.profile.workspaceId)
      .then((setlists) => Promise.all(setlists.map(async (setlist) => ({ setlist, status: await offlinePackageStatus(session.db, setlist.id) }))))
      .then((loaded) => current && setRows(loaded));
    return () => {
      current = false;
    };
  }, [session, version, imported]);

  async function create() {
    setError(null);
    try {
      const setlist = createSetlist({ title, serviceDate: date === '' ? null : date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo' }, session.context());
      await saveDocuments(session.db, [{ entityType: 'setlist', document: setlist }]);
      setLocalQuery({ view: 'repertorios', repertorio: setlist.id });
    } catch (reason) {
      setError(reason instanceof LocalSaveError ? reason.message : 'Não foi possível criar o repertório.');
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="setlists">
      <PageHeader title="Repertórios" />

      <form
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="min-w-48 flex-1">
          <Label htmlFor="rep-titulo" required>
            Nome do repertório
          </Label>
          <Input id="rep-titulo" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Culto de domingo" />
        </div>
        <div>
          <Label htmlFor="rep-data">Data do culto</Label>
          <Input id="rep-data" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <button type="submit" className={buttonClass('primary', 'md', 'max-sm:w-full')} disabled={title.trim() === ''}>
          <PlusIcon />
          Criar repertório
        </button>
        {error && (
          <p role="alert" className="w-full text-sm text-danger">
            {error}
          </p>
        )}
      </form>

      <PackageImport session={session} onImported={() => setImported((count) => count + 1)} />

      {rows === null ? (
        <Loading>Carregando…</Loading>
      ) : rows.length === 0 ? (
        <EmptyState icon={<SetlistIcon size={26} />} data-testid="setlists-empty">
          Nenhum repertório ainda.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Repertórios">
          {rows.map(({ setlist, status }) => (
            <li key={setlist.id} className={cn(rowClass, 'flex flex-wrap items-center gap-x-4 gap-y-3 p-4')} data-testid="setlist-row">
              <span aria-hidden="true" className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-accent/10 text-accent">
                {setlist.serviceDate ? (
                  <>
                    <span className="text-base font-bold leading-none tabular-nums">{setlist.serviceDate.slice(8, 10)}</span>
                    <span className="text-[10px] font-bold uppercase leading-tight">{MONTHS[Number(setlist.serviceDate.slice(5, 7)) - 1]}</span>
                  </>
                ) : (
                  <SetlistIcon size={22} />
                )}
              </span>
              <div className="min-w-0 flex-1 basis-48">
                <a
                  href={`/app?view=repertorios&repertorio=${setlist.id}`}
                  className="rounded text-base font-bold underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    setLocalQuery({ view: 'repertorios', repertorio: setlist.id });
                  }}
                >
                  {setlist.title}
                </a>
                <p className="text-sm text-muted">
                  {setlist.serviceDate ? new Date(`${setlist.serviceDate}T12:00:00`).toLocaleDateString('pt-BR') : 'Sem data'} · {setlist.items.length}{' '}
                  {setlist.items.length === 1 ? 'louvor' : 'louvores'}
                </p>
              </div>
              <span className={pillClass(STATE_TONE[status.state])} data-state={status.state}>
                {STATE_TEXT[status.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Loaded = { setlist: Setlist; entries: SetlistEntry[]; choices: ArrangementChoice[]; status: PackageStatus; audioBytes: number };

function SetlistDetail({ session, setlistId }: { session: LocalSession; setlistId: Uuid }) {
  const [loaded, setLoaded] = useState<Loaded | 'loading' | 'missing'>('loading');
  const [adding, setAdding] = useState('');
  const [preparing, setPreparing] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<Loaded | 'missing'> => {
    const setlist = await getSetlist(session.db, setlistId);
    if (!setlist) return 'missing';
    const [entries, choices, status] = await Promise.all([resolveSetlist(session.db, setlist), listArrangementChoices(session.db, session.profile.workspaceId), offlinePackageStatus(session.db, setlistId)]);
    // Espaço das faixas escolhidas, sem contar duas vezes o mesmo arquivo.
    const sizes = new Map<string, number>();
    for (const entry of entries) {
      const binding = entry.arrangement?.audioBindings.find((item) => item.id === entry.arrangement?.selectedAudioBindingId);
      const asset = binding ? await getAsset(session.db, binding.assetId) : null;
      if (asset) sizes.set(asset.sha256, asset.byteSize);
    }
    return { setlist, entries, choices, status, audioBytes: [...sizes.values()].reduce((sum, size) => sum + size, 0) };
  }, [session, setlistId]);
  const reload = () => load().then(setLoaded);
  const version = useLibraryVersion();
  // O repertório aberto fica marcado como em edição antes da leitura: uma
  // versão remota recebida enquanto isso não o troca por baixo desta tela.
  useEffect(() => {
    let current = true;
    let release: (() => void) | null = null;
    void acquireEditLease(session.db, [entityStateKey('setlist', setlistId)])
      .catch(() => null)
      .then((held) => {
        if (!current) return held?.();
        release = held;
        return load().then((next) => current && setLoaded(next));
      });
    return () => {
      current = false;
      release?.();
    };
  }, [load, session, setlistId]);
  // Louvores e arranjos referenciados podem mudar por sincronização.
  useEffect(() => {
    if (version > 0) void load().then(setLoaded);
  }, [load, version]);

  if (loaded === 'loading') return <Loading>Abrindo o repertório…</Loading>;
  if (loaded === 'missing') {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[1.75rem] font-bold leading-tight md:text-3xl">Repertório não encontrado</h1>
        <BackToList />
      </div>
    );
  }
  const { setlist, entries, choices, status, audioBytes } = loaded;

  async function save(next: Setlist) {
    setError(null);
    try {
      await saveDocuments(session.db, [{ entityType: 'setlist', document: touch(next, session.context()) }]);
      await reload();
    } catch (reason) {
      setError(reason instanceof LocalSaveError ? reason.message : 'Não foi possível gravar o repertório.');
    }
  }
  const saveItems = (items: SetlistItem[]) => save({ ...setlist, items });

  async function prepare() {
    setError(null);
    setPreparing({ done: 0, total: Math.max(1, entries.length), label: 'iniciando' });
    try {
      await prepareOfflinePackage(session.db, setlistId, {
        fonts: fontPack,
        verifyFont: verifyFontFile,
        probe: probeAudio,
        now: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
        onProgress: (done, total, label) => setPreparing({ done, total, label }),
      });
    } catch {
      setError('A preparação foi interrompida por um erro neste dispositivo. Nada foi marcado como pronto.');
    } finally {
      setPreparing(null);
      await reload();
    }
  }

  const state: OfflinePackageState = preparing ? 'preparing' : status.state;

  return (
    <div className="flex flex-col gap-6" data-testid="setlist" data-setlist-id={setlist.id}>
      <PageHeader
        before={<BackToList />}
        title={setlist.title}
        description={
          <>
            {setlist.serviceDate ? `Culto em ${new Date(`${setlist.serviceDate}T12:00:00`).toLocaleDateString('pt-BR')}` : 'Sem data definida'} · {entries.length}{' '}
            {entries.length === 1 ? 'louvor' : 'louvores'}
          </>
        }
        actions={<span className={pillClass(STATE_TONE[state])}>{STATE_SHORT[state]}</span>}
      />

      {error && (
        <p role="alert" className={noticeClass('danger')}>
          {error}
        </p>
      )}

      <section aria-labelledby="ordem" className="flex flex-col gap-4 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-6">
        <h2 id="ordem" className="text-lg font-bold">
          Ordem do culto
        </h2>
        {entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted">Nenhum louvor neste repertório. Escolha um abaixo.</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Louvores do repertório">
            {entries.map((entry, index) => (
              <li key={entry.item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-overlay/50 p-3 transition-colors hover:border-border-strong" data-testid="setlist-item" data-item-id={entry.item.id}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold tabular-nums text-accent">{index + 1}</span>
                <span className="min-w-0 flex-1 basis-40">
                  {entry.song && entry.arrangement ? (
                    <>
                      <span className="font-semibold">{entry.song.title}</span>
                      <span className="text-sm text-muted">
                        {' '}
                        · {entry.arrangement.name}
                        {entry.arrangement.selectedAudioBindingId ? ' · com áudio' : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-danger">Louvor removido da biblioteca</span>
                  )}
                </span>
                <button type="button" className={buttonClass('ghost', 'sm', 'px-2.5')} disabled={index === 0} aria-label={`Subir o louvor ${index + 1}`} onClick={() => void saveItems(moveSetlistItem(setlist.items, entry.item.id, index - 1))}>
                  ↑
                </button>
                <button type="button" className={buttonClass('ghost', 'sm', 'px-2.5')} disabled={index === entries.length - 1} aria-label={`Descer o louvor ${index + 1}`} onClick={() => void saveItems(moveSetlistItem(setlist.items, entry.item.id, index + 1))}>
                  ↓
                </button>
                {entry.song && entry.arrangement && (
                  <button
                    type="button"
                    className={buttonClass('primary', 'sm')}
                    aria-label={`Apresentar ${entry.song.title}`}
                    onClick={() => setLocalQuery({ view: 'apresentar', song: entry.song?.id ?? null, arranjo: entry.arrangement?.id ?? null, repertorio: setlist.id, item: entry.item.id })}
                  >
                    ▶ Apresentar
                  </button>
                )}
                <button type="button" className={buttonClass('ghost', 'sm', 'hover:text-danger')} aria-label={`Remover o louvor ${index + 1} do repertório`} onClick={() => void saveItems(removeSetlistItem(setlist.items, entry.item.id))}>
                  Remover
                </button>
              </li>
            ))}
          </ol>
        )}

        <form
          className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding === '') return;
            // O campo é limpo já: uma escolha feita enquanto a gravação termina não pode ser apagada depois.
            const arrangementId = adding;
            setAdding('');
            void saveItems(addSetlistItem(setlist.items, arrangementId, session.context().newId));
          }}
        >
          <div className="min-w-56 flex-1">
            <Label htmlFor="rep-adicionar">Acrescentar louvor</Label>
            <Select id="rep-adicionar" value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">Escolha na biblioteca…</option>
              {choices.map((choice) => (
                <option key={choice.arrangementId} value={choice.arrangementId}>
                  {choice.title} — {choice.arrangementName}
                </option>
              ))}
            </Select>
          </div>
          <button type="submit" className={buttonClass('secondary')} disabled={adding === ''}>
            Acrescentar
          </button>
        </form>
        {choices.length === 0 && <p className="text-sm text-muted">A biblioteca está vazia: cadastre um louvor primeiro.</p>}
      </section>

      <section aria-labelledby="preparo-offline" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-6">
        <h2 id="preparo-offline" className="text-lg font-bold">
          Uso offline
        </h2>
        <p role="status" data-testid="package-state" data-state={state} data-usable-copy={status.usableCopy} className={noticeClass(STATE_TONE[state], 'font-semibold')}>
          {STATE_TEXT[state]}
          {status.preparedAt && state !== 'preparing' && ` Última preparação concluída em ${new Date(status.preparedAt).toLocaleString('pt-BR')}.`}
        </p>
        {preparing && (
          <div role="status" className="flex flex-col gap-1 text-sm" data-testid="package-progress">
            <span>
              {preparing.done} de {preparing.total} conferências · {preparing.label}
            </span>
            <progress className="h-1.5 w-full accent-accent" value={preparing.done} max={preparing.total} />
          </div>
        )}
        {state === 'failed' && (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="package-problems">
            {status.problems.map((problem, index) => (
              <li key={index} data-code={problem.code}>
                {PROBLEM_TEXT[problem.code](problem)}{' '}
                {problem.songId && (
                  <button type="button" className="underline underline-offset-2" onClick={() => setLocalQuery({ view: 'editor', song: problem.songId ?? null, arranjo: problem.arrangementId ?? null, repertorio: null })}>
                    Abrir o louvor
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(state === 'stale' || (state === 'failed' && status.staleReasons.length > 0)) && (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="package-stale">
            {status.staleReasons.map((reason, index) => (
              <li key={index} data-code={reason.code}>
                {STALE_TEXT[reason.code]('subject' in reason ? reason.subject : '')}
              </li>
            ))}
          </ul>
        )}
        {status.usableCopy && (state === 'stale' || state === 'failed') && (
          <p className="text-sm text-muted" data-testid="package-copy">
            A cópia preparada antes continua utilizável: apresentar por este repertório usa a revisão que foi conferida, até você preparar de novo.
          </p>
        )}
        <p className="text-sm text-muted">
          A preparação confere cada louvor, o tema, os arquivos de fonte e os bytes da faixa escolhida de cada arranjo. Áudio deste repertório:{' '}
          <span data-testid="setlist-audio-bytes">{formatBytes(audioBytes)}</span>.
        </p>
        <button type="button" className={buttonClass('primary', 'md', 'self-start')} disabled={preparing !== null} onClick={() => void prepare()}>
          {state === 'ready' ? 'Conferir de novo' : status.usableCopy ? 'Preparar de novo' : 'Preparar para uso offline'}
        </button>
        {/* O que a conferência acima não enxerga: fica aqui, e não na tela que o público vê. */}
        <details className="text-sm" data-testid="pre-service-checklist">
          <summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Antes do culto, confira também</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>Computador ligado na tomada, com a suspensão e o protetor de tela desativados.</li>
            <li>É este o repertório do culto, na ordem certa.</li>
            <li>Projetor em área estendida (não espelhada), com a janela de projeção em tela cheia e a saída armada.</li>
            <li>Som: toque um trecho da faixa e ouça na caixa da igreja, não no computador.</li>
            <li>Desligue a internet e abra o repertório de novo: tudo precisa abrir sem ela.</li>
            <li>Olhe a parede: o primeiro slide está inteiro e legível do fundo da sala.</li>
          </ul>
        </details>
      </section>

      <PackageExport session={session} setlistId={setlist.id} refreshKey={loaded} />

      <section className="flex flex-col gap-2">
        {confirmDelete ? (
          <div role="alertdialog" aria-label="Confirmar exclusão do repertório" className={noticeClass('danger', 'flex flex-wrap items-center gap-3')}>
            <p className="min-w-0 flex-1 basis-64 text-foreground">O repertório vai para a lixeira e pode ser restaurado. Os louvores e os áudios continuam na biblioteca.</p>
            <button type="button" className={buttonClass('danger', 'sm')} onClick={() => void deleteSetlist(session.db, setlist.id, session.context()).then(() => setLocalQuery({ view: 'repertorios', repertorio: null }))}>
              Excluir repertório
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button type="button" className={buttonClass('danger', 'sm', 'self-start')} onClick={() => setConfirmDelete(true)}>
            Excluir repertório…
          </button>
        )}
      </section>
    </div>
  );
}

function BackToList() {
  return (
    <button type="button" className={buttonClass('ghost', 'sm', '-ml-2 self-start')} onClick={() => setLocalQuery({ view: 'repertorios', repertorio: null })}>
      ← Repertórios
    </button>
  );
}
