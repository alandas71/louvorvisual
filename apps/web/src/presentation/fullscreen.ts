/** Lê a orientação informada pelo sistema, nunca as dimensões do layout. */
export type DeviceOrientation = 'desktop' | 'portrait' | 'landscape' | 'unknown';

export function deviceOrientation(): DeviceOrientation {
  if (!window.matchMedia('(pointer: coarse)').matches) return 'desktop';
  const type = screen.orientation?.type;
  if (type?.startsWith('landscape')) return 'landscape';
  if (type?.startsWith('portrait')) return 'portrait';
  const angle = (window as Window & { orientation?: number }).orientation;
  if (typeof angle === 'number') return Math.abs(angle) === 90 ? 'landscape' : 'portrait';
  return 'unknown';
}

export function subscribeDeviceOrientation(update: () => void): () => void {
  const orientation = screen.orientation;
  const pointer = window.matchMedia('(pointer: coarse)');
  orientation?.addEventListener('change', update);
  pointer.addEventListener('change', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('resize', update);
  return () => {
    orientation?.removeEventListener('change', update);
    pointer.removeEventListener('change', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('resize', update);
  };
}

export async function enterPresentationFullscreen(): Promise<'entered' | 'rotate-device'> {
  // Não iniciar tela cheia na vertical, nem simular paisagem por CSS.
  if (deviceOrientation() === 'portrait') return 'rotate-device';
  if (document.fullscreenElement) return 'entered';
  const installed = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  try {
    if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable');
    await document.documentElement.requestFullscreen();
  } catch (error) {
    // O PWA já ocupa uma janela própria; alguns sistemas não oferecem outra API.
    if (!installed) throw error;
  }
  return 'entered';
}

/** Sair da tela cheia preserva a orientação escolhida pelo usuário no sistema. */
export async function exitPresentationFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
}
