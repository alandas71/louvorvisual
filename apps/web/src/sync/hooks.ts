'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocalSession, type LocalSession } from '@/local/session';
import { LIBRARY_CHANGED_EVENT, syncEngine, type SyncEngine, type SyncStatus } from './engine';

const LOADING: SyncStatus = { connection: 'local-only', leader: false, summary: null, lastOutcome: null, cycles: 0, nextRetryAt: null };
const noop = () => () => undefined;

/** Motor de sincronização do perfil aberto; `null` enquanto o banco local abre. */
export function useSyncEngine(): { engine: SyncEngine; session: LocalSession } | null {
  const local = useLocalSession();
  const session = local.status === 'ready' ? local.session : null;
  return useMemo(() => (session ? { engine: syncEngine(session), session } : null), [session]);
}

export function useSyncStatus(engine: SyncEngine | null): SyncStatus {
  return useSyncExternalStore(engine?.subscribe ?? noop, engine?.getStatus ?? (() => LOADING), () => LOADING);
}

/** Contador que muda quando a biblioteca local foi alterada por sincronização ou por outra janela. */
export function useLibraryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((current) => current + 1);
    window.addEventListener(LIBRARY_CHANGED_EVENT, bump);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, bump);
  }, []);
  return version;
}
