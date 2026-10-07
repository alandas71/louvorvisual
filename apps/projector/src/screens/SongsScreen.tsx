'use client';

import type { SongSummary } from '@louvorvisual/contracts';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';
import { PAGE_SIZE, SongMeta, usePaged } from './shared';

/** Louvores locais, em páginas; OK prepara a apresentação do louvor avulso. */
export function SongsScreen({ focusKey }: { focusKey: string | null }) {
  const app = useApp();
  const { host } = app;
  const paged = usePaged<SongSummary>((cursor) => host.request('library.listSongs', { cursor, limit: PAGE_SIZE }));
  const ref = useFocusLayer<HTMLElement>({ name: 'songs', level: 0, repeat: 'directions', onBack: () => app.back() });

  return (
    <main className="screen" ref={ref} data-layer="songs">
      <header className="screen-header">
        <h1>Louvores locais</h1>
        <p data-testid="songs-count">{paged.status === 'done' ? `${paged.items.length} neste aparelho` : `${paged.items.length} carregados`}</p>
      </header>
      <div className="list" data-testid="song-list">
        {paged.items.map((song, index) => (
          <Action
            key={song.arrangementId}
            className="row"
            focusKey={`song:${song.arrangementId}`}
            autoFocus={focusKey === `song:${song.arrangementId}`}
            onFocus={() => index >= paged.items.length - 4 && paged.more()}
            onSelect={() => app.go({ name: 'presentation', request: { kind: 'start', arrangementId: song.arrangementId, context: { setlistId: null, itemId: null }, queue: [] } })}
          >
            <span className="row-main">
              <span className="row-title">{song.title}</span>{' '}
              <span className="row-sub">{song.artist ?? ''}</span>
            </span>
            <SongMeta song={song} />
          </Action>
        ))}
        {paged.status === 'done' && paged.items.length === 0 && (
          <div className="panel">
            <h2>Nenhum louvor neste aparelho</h2>
            <p>Importe um pacote ou entre na equipe em Configurações para sincronizar.</p>
            <Action className="button" autoFocus onSelect={() => app.replace({ name: 'import' })}>
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
      <p className="hint">{paged.status === 'loading' ? 'Carregando…' : 'OK prepara o louvor · Voltar retorna ao início'}</p>
    </main>
  );
}
