'use client';

import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { FavoriteIcon, LibraryIcon, PlayIcon } from '@/components/ui/icons';
import { EmptyState, Loading, PageHeader, rowClass } from '@/components/ui/PageHeader';
import { setLocalQuery } from '@/lib/localQuery';
import { listArrangements, listFavoriteSongIndex, toggleFavoriteSong, useLocalSession, type LocalSession, type SongIndexRow } from '@/local';
import { cn } from '@/lib/utils';
import { DownloadAudioButton } from '../audio/DownloadAudioButton';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Atalhos pessoais do operador; nunca alteram nem sincronizam os louvores. */
export function FavoritesView() {
  const local = useLocalSession();
  if (local.status === 'loading') return <Loading>Abrindo os favoritos…</Loading>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  return <Favorites session={local.session} />;
}

function Favorites({ session }: { session: LocalSession }) {
  const canManageLibrary = session.team?.role !== 'operator';
  const [rows, setRows] = useState<SongIndexRow[] | null>(null);
  const reload = useCallback(() => listFavoriteSongIndex(session.db, session.profile.workspaceId).then(setRows), [session]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function present(row: SongIndexRow) {
    const [arrangement] = await listArrangements(session.db, row.id).catch(() => []);
    setLocalQuery({ view: 'apresentar', song: row.id, arranjo: arrangement?.id ?? null, faixa: null });
  }

  async function remove(row: SongIndexRow) {
    await toggleFavoriteSong(session.db, session.profile.workspaceId, row.id);
    await reload();
  }

  return (
    <div className="flex flex-col gap-6" data-testid="favorites-view">
      <PageHeader title="Favoritos" description="Louvores marcados para acesso rápido neste dispositivo." />

      {rows === null ? (
        <Loading>Carregando favoritos…</Loading>
      ) : rows.length === 0 ? (
        <EmptyState icon={<FavoriteIcon size={26} />} title="Nenhum favorito ainda" data-testid="favorites-empty">
          Na Biblioteca, marque os louvores que você mais usa para encontrá-los aqui rapidamente.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Louvores favoritos">
          {rows.map((row) => (
            <li key={row.id} className={cn(rowClass, 'p-4 sm:px-5')}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                  <FavoriteIcon size={19} />
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  {canManageLibrary ? <a
                    href={`/app?view=editor&song=${row.id}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      setLocalQuery({ view: 'editor', song: row.id, arranjo: null });
                    }}
                    className="rounded text-base font-semibold leading-snug underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {row.title}
                  </a> : <p className="text-base font-semibold leading-snug">{row.title}</p>}
                  <p className="mt-0.5 truncate text-[13px] text-muted">{row.artist ?? 'Sem artista'} · editado em {dateFormat.format(new Date(row.updatedAt))}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
                  <DownloadAudioButton session={session} songId={row.id} title={row.title} />
                  <button type="button" className={buttonClass('secondary', 'sm', 'border-accent/40 bg-accent/10 text-accent hover:border-accent hover:bg-accent/15 max-sm:flex-1')} onClick={() => void present(row)} aria-label={`Apresentar ${row.title}`}>
                    <PlayIcon size={14} />
                    Apresentar
                  </button>
                  <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => void remove(row)} aria-label={`Remover ${row.title} dos favoritos`}>
                    <FavoriteIcon size={16} />
                    Remover
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows?.length === 0 && (
        <a href="/app?view=biblioteca" onClick={(event) => { event.preventDefault(); setLocalQuery({ view: 'biblioteca', song: null, arranjo: null }); }} className={buttonClass('secondary', 'md', 'self-start')}>
          <LibraryIcon />
          Abrir Biblioteca
        </a>
      )}
    </div>
  );
}
