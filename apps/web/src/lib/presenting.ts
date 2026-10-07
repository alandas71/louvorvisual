/** Área do operador ou janela de projeção: aqui nada pode interromper a sessão. */
export function isPresentingWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/projecao' || new URLSearchParams(window.location.search).get('view') === 'apresentar';
}
