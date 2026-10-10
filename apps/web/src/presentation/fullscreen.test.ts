import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { enterPresentationFullscreen, unlockPresentationOrientation } from './fullscreen';

describe('rotação real na apresentação do PWA', () => {
  const element = {};
  const lock = vi.fn<(orientation: string) => Promise<void>>(async () => {});
  const unlock = vi.fn();
  const requestFullscreen = vi.fn(async () => { doc.fullscreenElement = element; });
  const doc = { fullscreenElement: null as object | null, documentElement: { requestFullscreen } };
  const matchMedia = vi.fn<(query: string) => { matches: boolean }>(() => ({ matches: false }));

  beforeEach(() => {
    vi.clearAllMocks();
    doc.fullscreenElement = null;
    doc.documentElement.requestFullscreen = requestFullscreen;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('screen', { orientation: { lock, unlock } });
    vi.stubGlobal('window', { matchMedia });
    vi.stubGlobal('navigator', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pede orientação do sistema depois de entrar em tela cheia', async () => {
    lock.mockImplementationOnce(async () => { expect(doc.fullscreenElement).toBe(element); });
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: true, active: true });
    expect(lock).toHaveBeenCalledWith('landscape');
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('pede paisagem no PWA standalone mesmo sem API de tela cheia', async () => {
    matchMedia.mockImplementationOnce((query) => ({ matches: query === '(display-mode: standalone)' }));
    doc.documentElement.requestFullscreen = undefined!;
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: true, active: true });
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('tenta orientação quando o PWA instalado recusa a tela cheia adicional', async () => {
    vi.stubGlobal('navigator', { standalone: true });
    requestFullscreen.mockRejectedValueOnce(new Error('Not allowed'));
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: true, active: true });
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('informa recusa de tela cheia em aba comum', async () => {
    requestFullscreen.mockRejectedValueOnce(new Error('Denied'));
    await expect(enterPresentationFullscreen()).rejects.toThrow('Denied');
    expect(lock).not.toHaveBeenCalled();
  });

  it('não quebra quando o celular não oferece orientação programática', async () => {
    vi.stubGlobal('screen', {});
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: false, active: true });
    expect(doc.fullscreenElement).toBe(element);
  });

  it('preserva tela cheia quando a orientação é recusada', async () => {
    lock.mockRejectedValueOnce(new Error('NotSupportedError'));
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: false, active: true });
    expect(doc.fullscreenElement).toBe(element);
  });

  it('libera a orientação se o usuário sair durante a rotação', async () => {
    lock.mockImplementationOnce(async () => { doc.fullscreenElement = null; });
    expect(await enterPresentationFullscreen()).toEqual({ orientationLocked: false, active: false });
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('não pede novamente tela cheia quando ela já está ativa', async () => {
    doc.fullscreenElement = element;
    await enterPresentationFullscreen();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('permite liberar orientação sem API disponível', () => {
    vi.stubGlobal('screen', {});
    expect(() => unlockPresentationOrientation()).not.toThrow();
  });
});
