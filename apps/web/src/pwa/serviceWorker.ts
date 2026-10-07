'use client';

import { useSyncExternalStore } from 'react';
import { isPresentingWindow } from '@/lib/presenting';

/** Nome do lock mantido por uma janela em apresentação; ver src/sw/sw.template.js. */
export const SESSION_LOCK = 'lv-presentation-session';

export type OfflineState = {
  phase: 'checking' | 'unsupported' | 'disabled' | 'installing' | 'ready' | 'failed';
  /** Versão do aplicativo em uso nesta janela. */
  version: string | null;
  cached: number;
  expected: number;
  /** Há uma versão nova baixada, aguardando o operador. */
  updateWaiting: boolean;
  /** Outra versão assumiu com esta janela em apresentação: a recarga ficou para depois. */
  reloadDeferred: boolean;
  error: string | null;
};

type ActivateReply = { activated: boolean; reason: 'session-active' | 'locks-unsupported' | 'not-waiting' | null };

let state: OfflineState = { phase: 'checking', version: null, cached: 0, expected: 0, updateWaiting: false, reloadDeferred: false, error: null };
const SERVER_STATE = state;
const listeners = new Set<() => void>();
let started = false;

function update(changes: Partial<OfflineState>) {
  state = { ...state, ...changes };
  for (const listener of listeners) listener();
}

function ask<T>(worker: ServiceWorker, type: 'STATUS' | 'ACTIVATE'): Promise<T> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('O service worker não respondeu.')), 10_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data as T);
    };
    worker.postMessage({ type }, [channel.port2]);
  });
}

async function refresh(registration: ServiceWorkerRegistration) {
  const active = registration.active;
  const updateWaiting = Boolean(registration.waiting && active);
  if (!active) {
    update({ phase: 'installing', updateWaiting });
    return;
  }
  const reply = await ask<{ version: string; expected: number; cached: number }>(active, 'STATUS');
  update({
    phase: reply.cached >= reply.expected ? 'ready' : 'failed',
    error: reply.cached >= reply.expected ? null : 'O cache do aplicativo está incompleto.',
    ...reply,
    updateWaiting,
  });
}

function watch(registration: ServiceWorkerRegistration, worker: ServiceWorker | null) {
  if (!worker) return;
  const firstInstall = !registration.active;
  worker.addEventListener('statechange', () => {
    // `redundant` sem ter ativado significa que a instalação falhou.
    if (worker.state === 'redundant' && firstInstall && !registration.active) {
      update({ phase: 'failed', error: 'Não foi possível baixar o aplicativo para uso offline.' });
      return;
    }
    void refresh(registration).catch(() => undefined);
  });
}

/** Registra o service worker uma vez por janela. Só existe no build de produção. */
export function startServiceWorker(): void {
  if (started) return;
  started = true;
  if (!('serviceWorker' in navigator)) {
    update({ phase: 'unsupported' });
    return;
  }
  if (process.env.NODE_ENV !== 'production') {
    update({ phase: 'disabled' });
    return;
  }

  // Quando outra versão assume, esta janela recarrega para usar documentos e
  // scripts do mesmo build. Não acontece na primeira instalação — e nunca em
  // uma janela de apresentação: o service worker já recusa a troca enquanto
  // há sessão, e esta é a segunda barreira. Os arquivos da versão em uso já
  // estão na memória da página; ela segue até o operador encerrar.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (isPresentingWindow()) {
      update({ reloadDeferred: true });
      return;
    }
    window.location.reload();
  });

  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((registration) => {
      watch(registration, registration.installing);
      registration.addEventListener('updatefound', () => watch(registration, registration.installing));
      return refresh(registration);
    })
    .catch((error: unknown) => {
      update({ phase: 'failed', error: error instanceof Error ? error.message : 'Falha ao registrar o service worker.' });
    });
}

/** Procura uma versão nova no servidor; sem rede, apenas não encontra. */
export async function checkForUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  await registration.update().catch(() => undefined);
  await refresh(registration);
}

/** Pede a troca para a versão baixada. É recusada enquanto houver apresentação aberta. */
export async function applyUpdate(): Promise<ActivateReply> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.waiting) return { activated: false, reason: 'not-waiting' };
  return ask<ActivateReply>(registration.waiting, 'ACTIVATE');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOfflineState(): OfflineState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
