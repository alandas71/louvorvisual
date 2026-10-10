'use client';

import { duplicateSong, findSimilarSongs, searchSongEntries, type Uuid } from '@louvorvisual/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { CheckIcon, CopyIcon, LibraryIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { EmptyState, Loading, noticeClass, PageHeader, rowClass } from '@/components/ui/PageHeader';
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
import { DownloadAudioButton } from '../audio/DownloadAudioButton';

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
        description={<>{session.team ? `Biblioteca da equipe ${session.team.workspaceName} neste dispositivo.` : 'Louvores gravados neste dispositivo.'} Letras e arranjos funcionam sem conexão. Ouça as faixas online ou use o ícone de baixar para ouvir offline.</>}
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
            {results.map((row) => (
              <li key={row.id} data-testid="library-item" className={cn(rowClass, 'p-4')}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-lg font-bold uppercase text-accent">
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
                      className="rounded text-base font-bold underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {row.title}
                    </a>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {row.artist ?? 'Sem artista'} · editado em {dateFormat.format(new Date(row.updatedAt))}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 max-sm:w-full">
                    <DownloadAudioButton session={session} songId={row.id} title={row.title} />
                    <button type="button" className={buttonClass('secondary', 'sm', 'border-accent/50 text-accent hover:border-accent max-sm:flex-1')} onClick={() => setLocalQuery({ view: 'apresentar', song: row.id, arranjo: null })} aria-label={`Apresentar ${row.title}`}>
                      ▶ Apresentar
                    </button>
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => void onDuplicate(row)} aria-label={`Duplicar ${row.title}`}>
                      <CopyIcon size={15} />
                      Duplicar
                    </button>
                    <button type="button" className={buttonClass('danger', 'sm')} onClick={() => setConfirming(row.id)} aria-label={`Excluir ${row.title}`}>
                      <TrashIcon size={15} />
                      Excluir
                    </button>
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
          {results.length === 0 && (
            <EmptyState icon={<SearchIcon size={26} />}>Nenhum louvor corresponde à busca.</EmptyState>
          )}
        </>
      )}
    </div>
  );
}
