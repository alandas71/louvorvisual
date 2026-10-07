'use client';

import { useSyncExternalStore } from 'react';

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** O que o navegador informa sobre a rede; o aplicativo funciona nos dois casos. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let listening = false;

function notify() {
  for (const listener of listeners) listener();
}

function subscribeInstall(listener: () => void) {
  if (!listening) {
    listening = true;
    // O navegador oferece a instalação uma vez; o evento fica guardado até a pessoa pedir.
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferred = event as InstallPromptEvent;
      notify();
    });
    window.addEventListener('appinstalled', () => {
      deferred = null;
      notify();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `install` existe só quando o navegador permite instalar agora. */
export function useInstallPrompt(): { install: (() => Promise<void>) | null } {
  const available = useSyncExternalStore(subscribeInstall, () => deferred !== null, () => false);
  if (!available) return { install: null };
  return {
    install: async () => {
      const event = deferred;
      if (!event) return;
      await event.prompt();
      await event.userChoice.catch(() => undefined);
      deferred = null;
      notify();
    },
  };
}
