'use client';

import { DEFAULT_PROJECTOR_PREFS, type HostResult, type ProjectorPrefs, type RecoverableSession } from '@louvorvisual/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { AppContext, type AppServices, type Screen } from './app-context';
import type { HostClient } from './host/client';
import { connectHost, HostUnavailableError, type HostUnavailableReason } from './host/connect';
import { focusManager } from './input/focus';
import { KeyNormalizer } from './input/normalizer';
import { PresentationScreen } from './presentation/PresentationScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ImportScreen } from './screens/ImportScreen';
import { SetlistScreen } from './screens/SetlistScreen';
import { SetlistsScreen } from './screens/SetlistsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SongsScreen } from './screens/SongsScreen';

type Boot =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: HostUnavailableReason }
  | { status: 'ready'; host: HostClient; info: HostResult<'host.info'>; prefs: ProjectorPrefs; recoverable: RecoverableSession | null };

const UNAVAILABLE_TEXT: Record<HostUnavailableReason, string> = {
  'no-host': 'Esta interface faz parte do aplicativo LouvorVisual do projetor e não funciona sozinha em um navegador.',
  incompatible: 'O aplicativo instalado e a interface são de versões diferentes. Reinstale o LouvorVisual.',
  'no-answer': 'O aplicativo não respondeu. Feche o LouvorVisual e abra de novo.',
};

type Entry = { screen: Screen; focusKey: string | null };

/** Diagnóstico da entrada: o que virou comando, e em qual contexto de foco. */
type InputTrace = { accepted: string[]; stats: KeyNormalizer['stats'] };

/**
 * Raiz do aplicativo do projetor. Liga a ponte, entrega as teclas do controle
 * ao contexto de foco e troca de tela por estado local: é um único documento,
 * sem rotas nem navegação do Next.
 */
export function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [stack, setStack] = useState<Entry[]>([{ screen: { name: 'home' }, focusKey: null }]);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { client, info } = await connectHost();
        // Preferências e sessão interrompida são do aparelho; sem elas o aplicativo abre no padrão.
        const prefs = await client.request('prefs.get', {}).then(
          (result) => result.prefs,
          () => DEFAULT_PROJECTOR_PREFS,
        );
        const recoverable = await client.request('session.findRecoverable', {}).then(
          (result) => result.session,
          () => null,
        );
        if (current) setBoot({ status: 'ready', host: client, info, prefs, recoverable });
      } catch (error) {
        if (current) setBoot({ status: 'unavailable', reason: error instanceof HostUnavailableError ? error.reason : 'no-answer' });
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  const host = boot.status === 'ready' ? boot.host : null;

  // Único caminho de teclas: host → normalizador → camada de foco do topo.
  useEffect(() => {
    if (!host) return;
    const normalizer = new KeyNormalizer();
    const trace: InputTrace = { accepted: [], stats: normalizer.stats };
    (window as unknown as { __lvInput: InputTrace }).__lvInput = trace;
    return host.on('remote.key', (event) => {
      const decision = normalizer.accept(event, focusManager.context(), performance.now());
      if (decision.command === null) return;
      const { command } = decision;
      trace.accepted.push(`${focusManager.activeLayer() ?? '-'}:${command}`);
      if (trace.accepted.length > 1000) trace.accepted.splice(0, 500);
      // A tela é atualizada antes de a próxima tecla ser lida: cada tecla vê o contexto que a anterior deixou.
      flushSync(() => focusManager.handle(command));
    });
  }, [host]);

  const safeArea = boot.status === 'ready' ? boot.prefs.safeAreaPercent : 0;
  useEffect(() => {
    document.documentElement.style.setProperty('--safe', `${safeArea}vmin`);
  }, [safeArea]);

  const currentFocusKey = () => (document.activeElement instanceof HTMLElement ? (document.activeElement.dataset.focusKey ?? null) : null);

  const go = useCallback((screen: Screen) => {
    const focusKey = currentFocusKey();
    setStack((entries) => [...entries.slice(0, -1), { ...(entries.at(-1) as Entry), focusKey }, { screen, focusKey: null }]);
  }, []);
  const replace = useCallback((screen: Screen) => setStack((entries) => [...entries.slice(0, -1), { screen, focusKey: null }]), []);
  const back = useCallback((focusKey?: string) => {
    setStack((entries) => {
      if (entries.length <= 1) return entries;
      const rest = entries.slice(0, -1);
      return focusKey === undefined ? rest : [...rest.slice(0, -1), { ...(rest.at(-1) as Entry), focusKey }];
    });
  }, []);

  const updatePrefs = useCallback(
    (changes: Partial<ProjectorPrefs>) => {
      setBoot((value) => (value.status === 'ready' ? { ...value, prefs: { ...value.prefs, ...changes } } : value));
      // Os pedidos saem na ordem das mudanças; se o host falhar, a preferência vale só até fechar o aplicativo.
      void host?.request('prefs.set', { prefs: changes }).catch(() => undefined);
    },
    [host],
  );
  const setRecoverable = useCallback((recoverable: RecoverableSession | null) => setBoot((value) => (value.status === 'ready' ? { ...value, recoverable } : value)), []);

  const services = useMemo<AppServices | null>(
    () => (boot.status === 'ready' ? { host: boot.host, info: boot.info, prefs: boot.prefs, recoverable: boot.recoverable, updatePrefs, setRecoverable, go, replace, back } : null),
    [boot, updatePrefs, setRecoverable, go, replace, back],
  );

  if (boot.status === 'loading') {
    return (
      <div className="app" data-testid="boot-loading">
        <main className="screen">
          <p className="status">Abrindo…</p>
        </main>
      </div>
    );
  }
  if (boot.status === 'unavailable' || !services) {
    return (
      <div className="app" data-testid="host-unavailable">
        <main className="screen">
          <header className="screen-header">
            <h1>LouvorVisual</h1>
          </header>
          <p role="alert">{UNAVAILABLE_TEXT[boot.status === 'unavailable' ? boot.reason : 'no-answer']}</p>
        </main>
      </div>
    );
  }

  const entry = stack.at(-1) as Entry;
  const { screen } = entry;
  return (
    <AppContext.Provider value={services}>
      <div className="app" data-testid="app" data-screen={screen.name}>
        {screen.name === 'home' && <HomeScreen focusKey={entry.focusKey} />}
        {screen.name === 'setlists' && <SetlistsScreen focusKey={entry.focusKey} />}
        {screen.name === 'setlist' && <SetlistScreen key={screen.setlistId} setlistId={screen.setlistId} focusKey={entry.focusKey} />}
        {screen.name === 'songs' && <SongsScreen focusKey={entry.focusKey} />}
        {screen.name === 'import' && <ImportScreen />}
        {screen.name === 'settings' && <SettingsScreen />}
        {screen.name === 'presentation' && <PresentationScreen request={screen.request} />}
      </div>
    </AppContext.Provider>
  );
}
