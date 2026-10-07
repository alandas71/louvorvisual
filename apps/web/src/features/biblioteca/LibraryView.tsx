'use client';

import { duplicateSong, findSimilarSongs, searchSongEntries, type Uuid } from '@louvorvisual/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { setLocalQuery } from '@/lib/localQuery';
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

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function copyTitle(title: string, rows: readonly SongIndexRow[]): string {
  for (let count = 1; ; count += 1) {
    const candidate = count === 1 ? `${title} (cópia)` : `${title} (cópia ${count})`;
    if (findSimilarSongs(rows, candidate).length === 0) return candidate;
  }
}

export function LibraryView() {
  const local = useLocalSession();
  if (local.status === 'loading') return <p role="status">Abrindo a biblioteca…</p>;
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Biblioteca</h1>
          <p className="mt-1 text-muted">
            {session.team ? `Biblioteca da equipe ${session.team.workspaceName} neste dispositivo.` : 'Louvores gravados neste dispositivo.'} Tudo aqui funciona sem conexão.
          </p>
        </div>
        <button type="button" className={buttonClass('primary')} onClick={() => setLocalQuery({ view: 'novo', song: null, arranjo: null })}>
          Novo louvor
        </button>
      </header>

      <div>
        <Label htmlFor="busca">Buscar por título, artista, etiqueta ou letra</Label>
        <Input id="busca" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: gratidao" />
      </div>

      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}

      {rows === null ? (
        <p role="status">Carregando…</p>
      ) : rows.length === 0 ? (
        <p data-testid="library-empty" className="text-muted">
          Nenhum louvor ainda. Use &ldquo;Novo louvor&rdquo; para colar a primeira letra.
        </p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted" data-testid="library-count">
            {query.trim() === ''
              ? `${rows.length} ${rows.length === 1 ? 'louvor' : 'louvores'}`
              : `${results.length} de ${rows.length} ${rows.length === 1 ? 'louvor' : 'louvores'}`}
          </p>
          <ul className="flex flex-col gap-2" aria-label="Louvores">
            {results.map((row) => (
              <li key={row.id} data-testid="library-item" className="rounded-lg border border-border bg-surface-raised p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`/app?view=editor&song=${row.id}`}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                        event.preventDefault();
                        setLocalQuery({ view: 'editor', song: row.id, arranjo: null });
                      }}
                      className="font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {row.title}
                    </a>
                    <p className="text-sm text-muted">
                      {row.artist ?? 'Sem artista'} · editado em {dateFormat.format(new Date(row.updatedAt))}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setLocalQuery({ view: 'apresentar', song: row.id, arranjo: null })} aria-label={`Apresentar ${row.title}`}>
                      ▶ Apresentar
                    </button>
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => void onDuplicate(row)} aria-label={`Duplicar ${row.title}`}>
                      Duplicar
                    </button>
                    <button type="button" className={buttonClass('danger', 'sm')} onClick={() => setConfirming(row.id)} aria-label={`Excluir ${row.title}`}>
                      Excluir
                    </button>
                  </div>
                </div>
                {confirming === row.id && (
                  <div role="alertdialog" aria-label={`Confirmar exclusão de ${row.title}`} className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
                    <p className="min-w-0 flex-1">
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
          {results.length === 0 && <p className="text-muted">Nenhum louvor corresponde à busca.</p>}
        </>
      )}
    </div>
  );
}
