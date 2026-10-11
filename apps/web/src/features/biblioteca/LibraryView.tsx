'use client';

import { duplicateSong, findSimilarSongs, searchSongEntries, type AudioBinding, type Uuid } from '@louvorvisual/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buttonClass } from '@/components/ui/buttonStyles';
import { CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, LibraryIcon, MicIcon, PlayIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { EmptyState, Loading, noticeClass, PageHeader, pillClass, rowClass } from '@/components/ui/PageHeader';
import { setLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import {
  deleteSong,
  getSong,
  listArrangements,
  listSongIndex,
  saveDocuments,
  useLocalSession,
  type LocalSession,
  type SongIndexRow,
} from '@/local';
import { useLibraryVersion } from '@/sync/hooks';
import { AUDIO_KIND_TEXT } from '../apresentacao/labels';
import { DownloadAudioButton } from '../audio/DownloadAudioButton';

const PAGE_SIZE = 30;

const AUDIO_KIND_HELP = { original: 'A gravação com voz, para tocar junto.', playback: 'A base instrumental para a igreja cantar.' } as const;
/** Botão só com ícone: quadrado, com o nome no aria-label. */
const ICON_BUTTON = 'w-8 px-0 pointer-coarse:w-10';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function copyTitle(title: string, rows: readonly SongIndexRow[]): string {
  for (let count = 1; ; count += 1) {
    const candidate = count === 1 ? `${title} (cópia)` : `${title} (cópia ${count})`;
    if (findSimilarSongs(rows, candidate).length === 0) return candidate;
  }
}

export function LibraryView() {
  const local = useLocalSession();
  if (local.status === 'loading') return <Loading>Abrindo a biblioteca…</Loading>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  return <Library session={local.session} />;
}

function Library({ session }: { session: LocalSession }) {
  const [rows, setRows] = useState<SongIndexRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<Uuid | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ row: SongIndexRow; arrangementId: Uuid; bindings: readonly AudioBinding[]; selectedId: Uuid | null } | null>(null);
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(
    () => listSongIndex(session.db, session.profile.workspaceId).then(setRows),
    [session],
  );
  // Recarrega também quando a sincronização traz ou retira louvores.
  const version = useLibraryVersion();
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const results = useMemo(() => (rows ? searchSongEntries(rows, query) : []), [rows, query]);
  const visibleResults = results.slice(0, visibleCount);
  const hasMore = visibleResults.length < results.length;

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, rows]);

  const loadMore = useCallback(() => {
    setVisibleCount((current) => Math.min(current + PAGE_SIZE, results.length));
  }, [results.length]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: '320px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, visibleResults.length]);

  useEffect(() => {
    if (choosing) firstChoice.current?.focus();
  }, [choosing]);

  /** Com mais de uma faixa no arranjo, pergunta qual usar antes de abrir a apresentação. */
  async function onPresent(row: SongIndexRow) {
    const [arrangement] = await listArrangements(session.db, row.id).catch(() => []);
    if (arrangement && arrangement.audioBindings.length > 1) {
      setChoosing({ row, arrangementId: arrangement.id, bindings: arrangement.audioBindings, selectedId: arrangement.selectedAudioBindingId });
      return;
    }
    setLocalQuery({ view: 'apresentar', song: row.id, arranjo: null, faixa: null });
  }

  async function onDuplicate(row: SongIndexRow) {
    setMessage(null);
    try {
      const song = await getSong(session.db, row.id);
      if (!song || !rows) return;
      const copy = duplicateSong(song, await listArrangements(session.db, song.id), session.context(), copyTitle(song.title, rows));
      await saveDocuments(session.db, [
        { entityType: 'song', document: copy.song },
        ...copy.arrangements.map((document) => ({ entityType: 'arrangement' as const, document })),
      ]);
      await reload();
      setMessage(`"${copy.song.title}" foi criado como cópia independente.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível duplicar.');
    }
  }

  async function onDelete(row: SongIndexRow) {
    setMessage(null);
    try {
      await deleteSong(session.db, row.id, session.context());
      setConfirming(null);
      await reload();
      setMessage(`"${row.title}" foi para a lixeira.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível excluir.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Biblioteca"
        description={<>{session.team ? `Biblioteca da equipe ${session.team.workspaceName} neste dispositivo.` : 'Louvores gravados neste dispositivo.'} Letras e arranjos funcionam sem conexão. Use o botão de baixar para ter o áudio offline.</>}
        actions={
          <button type="button" className={buttonClass('primary')} onClick={() => setLocalQuery({ view: 'novo', song: null, arranjo: null })}>
            <PlusIcon />
            Novo louvor
          </button>
        }
      />

      {(rows === null || rows.length > 0) && (
        <div>
          <Label htmlFor="busca" className="sr-only">
            Buscar por título, artista, etiqueta ou letra
          </Label>
          <Input id="busca" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por título, artista, etiqueta ou letra" icon={<SearchIcon />} className="py-3" />
        </div>
      )}

      {message && (
        <p role="status" className={noticeClass('success', 'flex items-center gap-2 text-foreground')}>
          <CheckIcon className="shrink-0 text-success" />
          {message}
        </p>
      )}

      {rows === null ? (
        <Loading>Carregando…</Loading>
      ) : rows.length === 0 ? (
        <EmptyState icon={<LibraryIcon size={26} />} title="Sua biblioteca começa aqui" data-testid="library-empty">
          Nenhum louvor ainda. Use &ldquo;Novo louvor&rdquo; para colar a primeira letra.
        </EmptyState>
      ) : (
        <>
          <p role="status" className="text-sm text-muted" data-testid="library-count">
            {query.trim() === ''
              ? `${rows.length} ${rows.length === 1 ? 'louvor' : 'louvores'}`
              : `${results.length} de ${rows.length} ${rows.length === 1 ? 'louvor' : 'louvores'}`}
          </p>
          <ul className="flex flex-col gap-3" aria-label="Louvores">
            {visibleResults.map((row) => (
              <li key={row.id} data-testid="library-item" className={cn(rowClass, 'p-4 sm:px-5')}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-base font-bold uppercase text-accent">
                    {row.title.trim().charAt(0) || '♪'}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <a
                      href={`/app?view=editor&song=${row.id}`}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                        event.preventDefault();
                        setLocalQuery({ view: 'editor', song: row.id, arranjo: null });
                      }}
                      className="rounded text-base font-semibold leading-snug underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {row.title}
                    </a>
                    <p className="mt-0.5 truncate text-[13px] text-muted">
                      {row.artist ?? 'Sem artista'} · editado em {dateFormat.format(new Date(row.updatedAt))}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
                    <DownloadAudioButton session={session} songId={row.id} title={row.title} />
                    <button type="button" className={buttonClass('secondary', 'sm', 'border-accent/40 bg-accent/10 text-accent hover:border-accent hover:bg-accent/15 max-sm:flex-1')} onClick={() => void onPresent(row)} aria-label={`Apresentar ${row.title}`}>
                      <PlayIcon size={14} />
                      Apresentar
                    </button>
                    <span className="flex items-center gap-1 sm:ml-1 sm:border-l sm:border-border sm:pl-2">
                      <button type="button" className={buttonClass('ghost', 'sm', ICON_BUTTON)} onClick={() => void onDuplicate(row)} aria-label={`Duplicar ${row.title}`} title="Duplicar">
                        <CopyIcon size={16} />
                      </button>
                      <button type="button" className={buttonClass('ghost', 'sm', cn(ICON_BUTTON, 'hover:bg-danger/10 hover:text-danger'))} onClick={() => setConfirming(row.id)} aria-label={`Excluir ${row.title}`} title="Excluir">
                        <TrashIcon size={16} />
                      </button>
                    </span>
                  </div>
                </div>
                {confirming === row.id && (
                  <div role="alertdialog" aria-label={`Confirmar exclusão de ${row.title}`} className={noticeClass('danger', 'mt-4 flex flex-wrap items-center gap-3')}>
                    <p className="min-w-0 flex-1 basis-64 text-foreground">
                      O louvor e todos os seus arranjos saem da biblioteca e vão para a lixeira, de onde podem ser restaurados.
                      {session.team ? ' A exclusão também vale para a equipe.' : ''}
                    </p>
                    <button type="button" className={buttonClass('danger', 'sm')} onClick={() => void onDelete(row)}>
                      Mover para a lixeira
                    </button>
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setConfirming(null)}>
                      Cancelar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {hasMore && (
            <div ref={loadMoreRef} className="flex justify-center py-2" data-testid="library-load-more">
              <button type="button" className={buttonClass('secondary', 'sm')} onClick={loadMore}>Carregar mais louvores</button>
            </div>
          )}
          {/* No body: o contêiner animado da vista prenderia o `fixed` e a ordem de empilhamento. */}
          {choosing && createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="escolher-faixa"
              data-testid="present-audio-choice"
              className="fixed inset-0 z-50 flex animate-fade items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
              onClick={(event) => {
                if (event.target === event.currentTarget) setChoosing(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setChoosing(null);
              }}
            >
              <div className="flex w-full max-w-md animate-rise flex-col gap-5 rounded-3xl border border-border-strong bg-surface-raised p-5 shadow-pop sm:p-6">
                <div className="flex items-start gap-3">
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                    <PlayIcon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 id="escolher-faixa" className="text-lg font-bold leading-tight">
                      Qual áudio usar?
                    </h2>
                    <p className="mt-0.5 truncate text-sm text-muted">{choosing.row.title}</p>
                  </div>
                  <button type="button" className={buttonClass('ghost', 'sm', ICON_BUTTON)} onClick={() => setChoosing(null)} aria-label="Fechar">
                    <CloseIcon size={16} />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {choosing.bindings.map((binding, index) => (
                    <button
                      key={binding.id}
                      ref={index === 0 ? firstChoice : undefined}
                      type="button"
                      className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-border bg-surface-overlay/50 p-3 text-left transition-colors duration-150 hover:border-accent/60 hover:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() => {
                        setChoosing(null);
                        setLocalQuery({ view: 'apresentar', song: choosing.row.id, arranjo: choosing.arrangementId, faixa: binding.id });
                      }}
                    >
                      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-muted transition-colors duration-150 group-hover:text-accent">
                        {binding.kind === 'original' ? <MicIcon /> : <LibraryIcon />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                          {AUDIO_KIND_TEXT[binding.kind]}
                          {binding.id === choosing.selectedId && <span className={pillClass('accent', 'px-2 py-0.5 text-[11px]')}>Padrão do arranjo</span>}
                        </span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-muted">{AUDIO_KIND_HELP[binding.kind]}</span>
                      </span>
                      <ChevronRightIcon size={16} className="shrink-0 text-muted transition-colors duration-150 group-hover:text-accent" />
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted">Dá para trocar a faixa no painel da apresentação antes de iniciar.</p>
              </div>
            </div>,
            document.body,
          )}
          {results.length === 0 && (
            <EmptyState icon={<SearchIcon size={26} />}>Nenhum louvor corresponde à busca.</EmptyState>
          )}
        </>
      )}
    </div>
  );
}
