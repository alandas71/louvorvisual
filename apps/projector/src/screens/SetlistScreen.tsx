'use client';

import type { HostResult, SetlistEntry } from '@louvorvisual/contracts';
import type { Uuid } from '@louvorvisual/domain';
import { useEffect, useState } from 'react';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';
import { formatDate, hostErrorText, SongMeta } from './shared';

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: HostResult<'library.getSetlist'> };

/** Um repertório: ordem dos louvores e o que está pronto. Notas do repertório não aparecem aqui. */
export function SetlistScreen({ setlistId, focusKey }: { setlistId: Uuid; focusKey: string | null }) {
  const app = useApp();
  const { host } = app;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    host.request('library.getSetlist', { setlistId }).then(
      (data) => current && setLoaded({ status: 'ready', data }),
      (error: unknown) => current && setLoaded({ status: 'error', message: hostErrorText(error) }),
    );
    return () => {
      current = false;
    };
  }, [host, setlistId, attempt]);

  const ref = useFocusLayer<HTMLElement>({ name: 'setlist', level: 0, repeat: 'directions', onBack: () => app.back() });
  const present = (entry: SetlistEntry, queue: SetlistEntry[]) => {
    app.updatePrefs({ recentSetlistId: setlistId });
    app.go({ name: 'presentation', request: { kind: 'start', arrangementId: entry.arrangementId, context: { setlistId, itemId: entry.itemId }, queue } });
  };
  const items = loaded.status === 'ready' ? loaded.data.items : [];
  const wanted = focusKey ?? (items[0] ? `item:${items[0].itemId}` : null);

  return (
    <main className="screen" ref={ref} data-layer="setlist">
      <header className="screen-header">
        <h1 data-testid="setlist-title">{loaded.status === 'ready' ? loaded.data.setlist.title : 'Repertório'}</h1>
        <p>{loaded.status === 'ready' ? formatDate(loaded.data.setlist.serviceDate) : ''}</p>
      </header>
      <div className="list" data-testid="setlist-items">
        {items.map((entry, index) => (
          <Action key={entry.itemId} className="row" focusKey={`item:${entry.itemId}`} autoFocus={wanted === `item:${entry.itemId}`} onSelect={() => present(entry, items)}>
            <span className="row-index">{index + 1}</span>
            <span className="row-main">
              <span className="row-title">{entry.title}</span>{' '}
              <span className="row-sub">{entry.artist ?? ''}</span>
            </span>
            <SongMeta song={entry} />
          </Action>
        ))}
        {loaded.status === 'ready' && items.length === 0 && (
          <div className="panel">
            <h2>Este repertório está vazio</h2>
            <p>Monte o repertório no computador e sincronize, ou importe um pacote.</p>
            <Action className="button" autoFocus onSelect={() => app.back()}>
              Voltar
            </Action>
          </div>
        )}
        {loaded.status === 'error' && (
          <div className="panel">
            <p className="alert" role="alert">
              {loaded.message}
            </p>
            <Action
              className="button"
              autoFocus
              onSelect={() => {
                setLoaded({ status: 'loading' });
                setAttempt((value) => value + 1);
              }}
            >
              Tentar de novo
            </Action>
          </div>
        )}
      </div>
      <p className="hint">{loaded.status === 'loading' ? 'Carregando…' : 'OK prepara o louvor escolhido · a apresentação só começa quando você iniciar'}</p>
    </main>
  );
}
