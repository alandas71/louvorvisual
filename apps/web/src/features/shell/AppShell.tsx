'use client';

import { useEffect, useRef } from 'react';
import { SkipToContent } from '@/components/ui/SkipToContent';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { ServiceWorkerRegistration } from '@/pwa/ServiceWorkerRegistration';
import { useOfflineState } from '@/pwa/serviceWorker';
import { OperatorView } from '../apresentacao/OperatorView';
import { AccountView } from '../conta/AccountView';
import { LibraryView } from '../biblioteca/LibraryView';
import { NewSongView } from '../cadastro/NewSongView';
import { EditorView } from '../editor/EditorView';
import { TrashView } from '../lixeira/TrashView';
import { OfflineView } from '../offline/OfflineView';
import { SetlistsView } from '../repertorios/SetlistsView';
import { SyncStatusChip } from '../sync/SyncStatusChip';
import { SyncView } from '../sync/SyncView';
import { ThemesView } from '../temas/ThemesView';
import { DataNoticeBanner } from './DataNoticeBanner';

const VIEWS = [
  { id: 'biblioteca', label: 'Biblioteca', Component: LibraryView },
  { id: 'repertorios', label: 'Repertórios', Component: SetlistsView },
  { id: 'temas', label: 'Temas e fontes', Component: ThemesView },
  { id: 'lixeira', label: 'Lixeira e histórico', Component: TrashView },
  { id: 'offline', label: 'Disponível offline', Component: OfflineView },
  { id: 'sync', label: 'Sincronização', Component: SyncView },
  { id: 'conta', label: 'Conta e equipe', Component: AccountView },
] as const;

/** Vistas abertas a partir da biblioteca; na navegação contam como parte dela. */
const LIBRARY_VIEWS = [
  { id: 'novo', Component: NewSongView },
  { id: 'editor', Component: EditorView },
] as const;

/** Shell local: as vistas trocam pela query (`?view=`), sem ida ao servidor. */
export function AppShell() {
  const query = useLocalQuery();
  const offline = useOfflineState();
  const detail = LIBRARY_VIEWS.find((view) => view.id === query.get('view'));
  const current = VIEWS.find((view) => view.id === query.get('view')) ?? VIEWS[0];
  const Content = detail?.Component ?? current.Component;
  const viewId = query.get('view') === 'apresentar' ? 'apresentar' : (detail?.id ?? current.id);

  // Trocar de vista remove o botão que tinha o foco ("Novo louvor", "← Biblioteca").
  // Sem isto o foco cai no início do documento e quem usa teclado ou leitor de tela
  // atravessa a navegação de novo; o conteúdo novo recebe o foco quando ele se perde.
  const mainRef = useRef<HTMLElement>(null);
  const previousView = useRef(viewId);
  useEffect(() => {
    if (previousView.current === viewId) return;
    previousView.current = viewId;
    const active = document.activeElement;
    if (!active || active === document.body) mainRef.current?.focus();
  }, [viewId]);

  // A área do operador ocupa a janela inteira, sem a navegação do aplicativo.
  if (query.get('view') === 'apresentar') {
    return (
      <>
        {/* A sessão do operador segura a troca de versão do aplicativo enquanto existir (useOperatorSession). */}
        <ServiceWorkerRegistration />
        <OperatorView />
      </>
    );
  }

  return (
    <>
      <SkipToContent />
      <ServiceWorkerRegistration />
      <DataNoticeBanner />
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-6 py-6 md:flex-row md:gap-10">
        <nav aria-label="Áreas do aplicativo" className="md:w-52 md:shrink-0">
          <p className="mb-3 text-lg font-bold">LouvorVisual</p>
          {/* Fora da área do operador: durante a apresentação esta janela não sincroniza. */}
          <SyncStatusChip />
          <ul className="flex flex-wrap gap-2 md:flex-col">
            {VIEWS.map((view) => (
              <li key={view.id}>
                <a
                  href={`/app?view=${view.id}`}
                  aria-current={view.id === current.id ? 'page' : undefined}
                  onClick={(event) => {
                    // Clique simples troca a vista localmente; abrir em outra
                    // aba continua funcionando pelo endereço.
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    setLocalQuery({ view: view.id, song: null, arranjo: null, repertorio: null, item: null, conflito: null });
                  }}
                  className={cn(
                    'block rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    view.id === current.id ? 'bg-surface-raised text-foreground' : 'text-muted hover:text-foreground',
                  )}
                >
                  {view.label}
                  {view.id === 'offline' && offline.updateWaiting && <span className="ml-2 text-accent">• nova versão</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main ref={mainRef} id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none" data-view={detail?.id ?? current.id}>
          <Content />
        </main>
      </div>
    </>
  );
}
