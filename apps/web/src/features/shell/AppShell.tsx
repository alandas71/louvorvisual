'use client';

import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { AccountIcon, CloseIcon, InstallIcon, LibraryIcon, MoreIcon, OfflineIcon, SetlistIcon, SyncIcon, ThemesIcon, TrashIcon, WifiOffIcon } from '@/components/ui/icons';
import { SkipToContent } from '@/components/ui/SkipToContent';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { useInstallPrompt, useOnline } from '@/pwa/device';
import { ServiceWorkerRegistration } from '@/pwa/ServiceWorkerRegistration';
import { useOfflineState, type OfflineState } from '@/pwa/serviceWorker';
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
import { BrandMark } from './BrandMark';
import { DataNoticeBanner } from './DataNoticeBanner';

type IconType = ComponentType<{ size?: number; className?: string }>;

const VIEWS = [
  { id: 'biblioteca', label: 'Biblioteca', short: 'Biblioteca', group: 'culto', Icon: LibraryIcon as IconType, Component: LibraryView },
  { id: 'repertorios', label: 'Repertórios', short: 'Repertórios', group: 'culto', Icon: SetlistIcon as IconType, Component: SetlistsView },
  { id: 'temas', label: 'Temas e fontes', short: 'Temas', group: 'culto', Icon: ThemesIcon as IconType, Component: ThemesView },
  { id: 'lixeira', label: 'Lixeira e histórico', short: 'Lixeira', group: 'dispositivo', Icon: TrashIcon as IconType, Component: TrashView },
  { id: 'offline', label: 'Disponível offline', short: 'Offline', group: 'dispositivo', Icon: OfflineIcon as IconType, Component: OfflineView },
  { id: 'sync', label: 'Sincronização', short: 'Sincronizar', group: 'dispositivo', Icon: SyncIcon as IconType, Component: SyncView },
  { id: 'conta', label: 'Conta e equipe', short: 'Conta', group: 'dispositivo', Icon: AccountIcon as IconType, Component: AccountView },
] as const;

const GROUPS = [
  { id: 'culto', label: 'Culto' },
  { id: 'dispositivo', label: 'Dispositivo e equipe' },
] as const;

/** As áreas que cabem na barra inferior do celular; as demais ficam em "Mais". */
const TAB_BAR = ['biblioteca', 'repertorios', 'temas'];

/** Vistas abertas a partir da biblioteca; na navegação contam como parte dela. */
const LIBRARY_VIEWS = [
  { id: 'novo', Component: NewSongView },
  { id: 'editor', Component: EditorView },
] as const;

const CLEAR_DETAIL = { song: null, arranjo: null, repertorio: null, item: null, conflito: null };

/** Clique simples troca a vista localmente; abrir em outra aba continua funcionando pelo endereço. */
function goTo(event: MouseEvent, view: string, after?: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  setLocalQuery({ view, ...CLEAR_DETAIL });
  after?.();
}

const DEVICE_TEXT: Record<OfflineState['phase'], string | null> = {
  checking: null,
  unsupported: null,
  disabled: 'Modo de desenvolvimento',
  installing: 'Baixando para uso offline…',
  ready: 'Pronto para uso offline',
  failed: 'Uso offline incompleto',
};

/** Shell local: as vistas trocam pela query (`?view=`), sem ida ao servidor. */
export function AppShell() {
  const query = useLocalQuery();
  const offline = useOfflineState();
  const online = useOnline();
  const { install } = useInstallPrompt();
  const detail = LIBRARY_VIEWS.find((view) => view.id === query.get('view'));
  const current = VIEWS.find((view) => view.id === query.get('view')) ?? VIEWS[0];
  const Content = detail?.Component ?? current.Component;
  const viewId = query.get('view') === 'apresentar' ? 'apresentar' : (detail?.id ?? current.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Trocar de vista remove o botão que tinha o foco ("Novo louvor", "← Biblioteca").
  // Sem isto o foco cai no início do documento e quem usa teclado ou leitor de tela
  // atravessa a navegação de novo; o conteúdo novo recebe o foco quando ele se perde.
  const mainRef = useRef<HTMLElement>(null);
  const previousView = useRef(viewId);
  useEffect(() => {
    if (previousView.current === viewId) return;
    previousView.current = viewId;
    window.scrollTo({ top: 0 });
    const active = document.activeElement;
    if (!active || active === document.body) mainRef.current?.focus({ preventScroll: true });
  }, [viewId]);

  // Menu do celular: abre com o foco no botão de fechar, fecha com Esc e devolve o foco.
  useEffect(() => {
    if (!menuOpen) return;
    closeButton.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }

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

  const deviceText = DEVICE_TEXT[offline.phase];
  const inTabBar = TAB_BAR.includes(current.id);

  return (
    <>
      <SkipToContent />
      <ServiceWorkerRegistration />
      <div className="lv-stage flex min-h-dvh flex-col lg:pl-72">
        <DataNoticeBanner />

        {/* Celular: marca e estado da rede no topo; a navegação fica embaixo, ao alcance do polegar. */}
        <header className="sticky top-0 z-30 border-b border-border bg-surface/85 pt-safe backdrop-blur-md lg:hidden">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <a href="/app" onClick={(event) => goTo(event, 'biblioteca')} className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
              <BrandMark size={28} />
              <span className="text-base font-bold tracking-tight">LouvorVisual</span>
            </a>
            {!online && <OfflinePill />}
          </div>
        </header>

        {menuOpen && <div aria-hidden="true" className="fixed inset-0 z-40 animate-fade bg-black/70 backdrop-blur-sm lg:hidden" onClick={closeMenu} />}

        <aside
          id="lv-menu"
          data-open={menuOpen}
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[86vw] flex-col gap-5 overflow-y-auto border-r border-border bg-surface-raised px-4 pb-4 pt-5 scrollbar-thin',
            'duration-200 ease-out max-lg:shadow-pop lg:bg-surface-raised/60',
            // Ao abrir, o menu fica visível já (precisa aceitar o foco); ao fechar, só depois de deslizar para fora.
            menuOpen ? 'transition-transform max-lg:translate-x-0' : 'transition-[transform,visibility] max-lg:invisible max-lg:-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between gap-2 px-2">
            <p className="flex items-center gap-3 text-lg font-bold tracking-tight">
              <BrandMark size={32} />
              LouvorVisual
            </p>
            <button ref={closeButton} type="button" className={buttonClass('ghost', 'sm', 'px-2 lg:hidden')} aria-label="Fechar o menu" onClick={closeMenu}>
              <CloseIcon />
            </button>
          </div>

          {/* Fora da área do operador: durante a apresentação esta janela não sincroniza. */}
          <SyncStatusChip onNavigate={() => setMenuOpen(false)} />

          <nav aria-label="Áreas do aplicativo" className="flex flex-col gap-5">
            {GROUPS.map((group) => (
              <div key={group.id} className="flex flex-col gap-1">
                <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{group.label}</p>
                <ul className="flex flex-col gap-0.5">
                  {VIEWS.filter((view) => view.group === group.id).map((view) => {
                    const active = view.id === current.id;
                    return (
                      <li key={view.id}>
                        <a
                          href={`/app?view=${view.id}`}
                          aria-current={active ? 'page' : undefined}
                          onClick={(event) => goTo(event, view.id, () => setMenuOpen(false))}
                          className={cn(
                            'group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                            active ? 'bg-accent/12 text-foreground' : 'text-muted hover:bg-surface-overlay hover:text-foreground',
                          )}
                        >
                          {active && <span aria-hidden="true" className="absolute inset-y-2.5 left-0 w-1 rounded-full bg-accent" />}
                          <view.Icon size={19} className={cn('shrink-0 transition-colors', active ? 'text-accent' : 'text-muted group-hover:text-foreground')} />
                          <span className="min-w-0 flex-1">
                            {view.label}
                            {view.id === 'offline' && offline.updateWaiting && <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">• nova versão</span>}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-3 px-1 pt-2">
            {install && (
              <button type="button" className={buttonClass('secondary', 'md', 'w-full justify-start')} onClick={() => void install()}>
                <InstallIcon />
                Instalar aplicativo
              </button>
            )}
            <div className="flex flex-col gap-1.5 px-2 text-xs text-muted">
              {!online && <OfflinePill className="self-start" />}
              {deviceText && (
                <p className="flex items-center gap-2" data-testid="device-status" data-phase={offline.phase}>
                  <span
                    aria-hidden="true"
                    className={cn('h-2 w-2 shrink-0 rounded-full', offline.phase === 'ready' ? 'bg-success' : offline.phase === 'failed' ? 'bg-danger' : 'animate-pulse-soft bg-accent')}
                  />
                  {deviceText}
                </p>
              )}
            </div>
          </div>
        </aside>

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 pb-28 pt-6 outline-none sm:px-6 lg:px-10 lg:pb-16 lg:pt-10"
          data-view={detail?.id ?? current.id}
        >
          <div key={viewId} className="animate-rise">
            <Content />
          </div>
        </main>

        <nav aria-label="Navegação rápida" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-raised/95 pb-safe backdrop-blur-md lg:hidden">
          <ul className="mx-auto grid max-w-lg grid-cols-4">
            {VIEWS.filter((view) => TAB_BAR.includes(view.id)).map((view) => {
              const active = view.id === current.id;
              return (
                <li key={view.id}>
                  <a
                    href={`/app?view=${view.id}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={(event) => goTo(event, view.id)}
                    className={cn(
                      'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent',
                      active ? 'text-accent' : 'text-muted',
                    )}
                  >
                    <span className={cn('flex h-7 w-14 items-center justify-center rounded-full transition-colors', active && 'bg-accent/15')}>
                      <view.Icon size={21} />
                    </span>
                    {view.short}
                  </a>
                </li>
              );
            })}
            <li>
              <button
                ref={menuButton}
                type="button"
                aria-expanded={menuOpen}
                aria-controls="lv-menu"
                onClick={() => setMenuOpen(true)}
                className={cn(
                  'relative flex h-16 w-full cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent',
                  inTabBar ? 'text-muted' : 'text-accent',
                )}
              >
                <span className={cn('flex h-7 w-14 items-center justify-center rounded-full transition-colors', !inTabBar && 'bg-accent/15')}>
                  <MoreIcon size={21} />
                </span>
                {inTabBar ? 'Mais' : current.short}
                {offline.updateWaiting && <span aria-hidden="true" className="absolute right-[calc(50%-1.5rem)] top-2.5 h-2.5 w-2.5 rounded-full border-2 border-surface-raised bg-accent" />}
              </button>
            </li>
          </ul>
        </nav>
      </div>
    </>
  );
}

function OfflinePill({ className }: { className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2.5 py-1 text-xs font-semibold text-info', className)}>
      <WifiOffIcon size={14} />
      Sem conexão
    </span>
  );
}
