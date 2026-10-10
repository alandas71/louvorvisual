/** APIs do sistema: nenhuma transformação CSS é usada para orientar a tela. */
type MobileOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
};

function installedDisplay(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function enterPresentationFullscreen(): Promise<{ orientationLocked: boolean; active: boolean }> {
  const installed = installedDisplay();
  if (!document.fullscreenElement) {
    try {
      if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable');
      await document.documentElement.requestFullscreen();
    } catch (error) {
      // Um PWA instalado já tem uma janela própria. Ainda pode permitir a
      // orientação mesmo quando não oferece a API adicional de tela cheia.
      if (!installed) throw error;
    }
  }
  const nativeFullscreen = Boolean(document.fullscreenElement);
  const orientation = screen.orientation as MobileOrientation | undefined;
  if (!orientation?.lock) return { orientationLocked: false, active: !nativeFullscreen || Boolean(document.fullscreenElement) };
  try {
    await orientation.lock('landscape');
    // O usuário pode sair enquanto o Android ainda processa a rotação.
    if (nativeFullscreen && !document.fullscreenElement) {
      unlockPresentationOrientation();
      return { orientationLocked: false, active: false };
    }
    return { orientationLocked: true, active: true };
  } catch {
    return { orientationLocked: false, active: !nativeFullscreen || Boolean(document.fullscreenElement) };
  }
}

export function unlockPresentationOrientation(): void {
  try { screen.orientation?.unlock(); } catch { /* A orientação pode já estar liberada. */ }
}
