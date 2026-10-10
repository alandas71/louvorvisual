/** Tela cheia da apresentação: pede paisagem sem girar apenas o conteúdo do slide. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
};

let releaseOrientation: (() => void) | null = null;

export async function enterPresentationFullscreen(): Promise<void> {
  // Deve ser chamado diretamente pelo clique para preservar o gesto do usuário.
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();

  const orientation = screen.orientation as LockableOrientation | undefined;
  if (!orientation?.lock || !document.fullscreenElement) return;

  releaseOrientation?.();
  const release = () => {
    document.removeEventListener('fullscreenchange', onChange);
    try { orientation.unlock(); } catch { /* O navegador pode já ter liberado a orientação. */ }
    if (releaseOrientation === release) releaseOrientation = null;
  };
  const onChange = () => {
    if (!document.fullscreenElement) release();
  };
  releaseOrientation = release;
  document.addEventListener('fullscreenchange', onChange);
  try {
    await orientation.lock('landscape');
  } catch {
    // Alguns navegadores não permitem travar a orientação. A tela cheia continua
    // funcionando e o usuário pode deitar o celular com a rotação automática ativa.
    release();
  }
}

export async function exitPresentationFullscreen(): Promise<void> {
  await document.exitFullscreen();
  releaseOrientation?.();
}
