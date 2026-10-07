'use client';

import { useEffect } from 'react';
import { SESSION_LOCK, startServiceWorker } from './serviceWorker';

/**
 * Registra o service worker. Com `holdsSession`, a janela se declara em
 * apresentação enquanto existir, o que impede a troca de versão do aplicativo.
 */
export function ServiceWorkerRegistration({ holdsSession = false }: { holdsSession?: boolean }) {
  useEffect(() => {
    startServiceWorker();
  }, []);

  useEffect(() => {
    if (!holdsSession || !navigator.locks) return;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void navigator.locks.request(SESSION_LOCK, { mode: 'shared' }, () => held);
    return release;
  }, [holdsSession]);

  return null;
}
