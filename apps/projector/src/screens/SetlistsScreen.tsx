'use client';

import type { SetlistSummary } from '@louvorvisual/contracts';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';
import { formatDate, PAGE_SIZE, usePaged } from './shared';

/** Repertórios deste aparelho; o usado por último vem destacado, mas nada inicia sozinho. */
export function SetlistsScreen({ focusKey }: { focusKey: string | null }) {
  const app = useApp();
  const { host } = app;
  const paged = usePaged<SetlistSummary>((cursor) => host.request('library.listSetlists', { cursor, limit: PAGE_SIZE }));
  const ref = useFocusLayer<HTMLElement>({ name: 'setlists', level: 0, repeat: 'directions', onBack: () => app.back() });
  const recent = app.prefs.recentSetlistId;
  const wanted = focusKey ?? (recent ? `setlist:${recent}` : null);

  return (
    <main className="screen" ref={ref} data-layer="setlists">
      <header className="screen-header">
        <h1>Repertórios</h1>
        <p>Neste aparelho</p>
      </header>
      <div className="list" data-testid="setlist-list">
        {paged.items.map((setlist, index) => (
          <Action
            key={setlist.setlistId}
            className="row"
            focusKey={`setlist:${setlist.setlistId}`}
            autoFocus={wanted === `setlist:${setlist.setlistId}`}
            onFocus={() => index >= paged.items.length - 4 && paged.more()}
            onSelect={() => app.go({ name: 'setlist', setlistId: setlist.setlistId })}
          >
            <span className="row-main">
              <span className="row-title">{setlist.title}</span>
              <span className="row-sub">{formatDate(setlist.serviceDate)}</span>
            </span>
            {setlist.setlistId === recent && <span className="tag tag-accent">Usado por último</span>}
            <span className="row-meta">
              {setlist.itemCount} {setlist.itemCount === 1 ? 'louvor' : 'louvores'}
            </span>
          </Action>
        ))}
        {paged.status === 'done' && paged.items.length === 0 && (
          <div className="panel">
            <h2>Nenhum repertório neste aparelho</h2>
            <p>Importe um pacote ou entre na equipe em Configurações para sincronizar.</p>
            <Action className="button" autoFocus testId="empty-import" onSelect={() => app.replace({ name: 'import' })}>
              Importar pacote
            </Action>
          </div>
        )}
        {paged.status === 'error' && (
          <div className="panel">
            <p className="alert" role="alert">
              {paged.error}
            </p>
            <Action className="button" autoFocus={paged.items.length === 0} onSelect={paged.more}>
              Tentar de novo
            </Action>
          </div>
        )}
      </div>
      <p className="hint">{paged.status === 'loading' ? 'Carregando…' : 'OK abre o repertório · Voltar retorna ao início'}</p>
    </main>
  );
}
