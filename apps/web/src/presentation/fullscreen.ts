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

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape-primary') => Promise<void>;
};
let orientationRequested = false;

export function releasePresentationOrientation(): void {
  if (!orientationRequested) return;
  orientationRequested = false;
  try { screen.orientation?.unlock(); } catch { /* O sistema pode já ter liberado. */ }
}

export async function requestPresentationLandscape(): Promise<boolean> {
  const orientation = screen.orientation as LockableOrientation | undefined;
  if (!orientation?.lock) return false;
  try {
    // Uma direção definida evita alternar entre os dois sentidos horizontais.
    await orientation.lock('landscape-primary');
    orientationRequested = true;
    if (deviceOrientation() === 'landscape') return true;
    releasePresentationOrientation();
    return false;
  } catch {
    return false;
  }
}

export async function enterPresentationFullscreen(): Promise<'entered' | 'rotate-device'> {
  const installed = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const portrait = deviceOrientation() === 'portrait';
  const orientation = screen.orientation as LockableOrientation | undefined;
  if (portrait && !orientation?.lock) return 'rotate-device';

  // No PWA, pedir a rotação ao sistema antes de abrir a tela cheia adicional.
  // Em abas comuns, o navegador normalmente exige tela cheia para autorizar.
  if (portrait && installed && !await requestPresentationLandscape()) return 'rotate-device';
  const alreadyFullscreen = Boolean(document.fullscreenElement);
  if (!alreadyFullscreen) {
    try {
      if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable');
      await document.documentElement.requestFullscreen();
    } catch (error) {
      if (!installed) throw error;
    }
  }
  if (portrait && !installed && !await requestPresentationLandscape()) {
    if (!alreadyFullscreen && document.fullscreenElement) await document.exitFullscreen();
    return 'rotate-device';
  }
  return 'entered';
}

/** Sair devolve ao sistema o controle da orientação, sem forçar outro sentido. */
export async function exitPresentationFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
  releasePresentationOrientation();
}
