'use client';

import { useSyncExternalStore } from 'react';

// Estado local dos shells na query string. As trocas usam o histórico do
// navegador e não pedem nada ao servidor, por isso funcionam sem rede.
const CHANGE_EVENT = 'lv:querychange';

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Query atual; no HTML estático é sempre vazia e o shell mostra a vista padrão. */
export function useLocalQuery(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => '');
  return new URLSearchParams(search);
}

export function setLocalQuery(changes: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  window.history.pushState(null, '', query ? `?${query}` : window.location.pathname);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
