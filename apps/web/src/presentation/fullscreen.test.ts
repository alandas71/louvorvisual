import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { deviceOrientation, enterPresentationFullscreen, exitPresentationFullscreen, releasePresentationOrientation } from './fullscreen';

describe('giro físico antes da tela cheia', () => {
  const element = {};
  const requestFullscreen = vi.fn(async () => { doc.fullscreenElement = element; });
  const exitFullscreen = vi.fn(async () => { doc.fullscreenElement = null; });
  const doc = { exitFullscreen, fullscreenElement: null as object | null, documentElement: { requestFullscreen } };
  const matchMedia = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }));
  const lock = vi.fn();
  const win = { matchMedia, innerWidth: 360, innerHeight: 800, orientation: undefined as number | undefined };
  beforeEach(() => {
    vi.resetAllMocks();
    requestFullscreen.mockImplementation(async () => { doc.fullscreenElement = element; });
    exitFullscreen.mockImplementation(async () => { doc.fullscreenElement = null; });
    matchMedia.mockImplementation((query: string) => ({ matches: query === '(pointer: coarse)' }));
    doc.fullscreenElement = null;
    doc.documentElement.requestFullscreen = requestFullscreen;
    win.orientation = undefined;
    win.innerWidth = 360;
    win.innerHeight = 800;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary' } });
  });
  afterEach(() => { releasePresentationOrientation(); vi.unstubAllGlobals(); });

  it('pede giro físico sem abrir tela cheia nem travar orientação', async () => {
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });
  it('não aceita layout horizontal como rotação do sistema', async () => {
    win.innerWidth = 800;
    win.innerHeight = 360;
    expect(deviceOrientation()).toBe('portrait');
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
  it('libera tela cheia após a orientação real mudar', async () => {
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    vi.stubGlobal('screen', { orientation: { type: 'landscape-primary', lock } });
    expect(await enterPresentationFullscreen()).toBe('entered');
    expect(doc.fullscreenElement).toBe(element);
    expect(lock).not.toHaveBeenCalled();
  });
  it('aceita os dois sentidos horizontais do sistema', () => {
    vi.stubGlobal('screen', { orientation: { type: 'landscape-secondary' } });
    expect(deviceOrientation()).toBe('landscape');
  });
  it('lê a orientação legada quando ScreenOrientation não existe', () => {
    vi.stubGlobal('screen', {});
    win.orientation = -90;
    expect(deviceOrientation()).toBe('landscape');
    win.orientation = 0;
    expect(deviceOrientation()).toBe('portrait');
  });
  it('exige confirmação manual se o sistema não informa orientação', () => {
    vi.stubGlobal('screen', {});
    expect(deviceOrientation()).toBe('unknown');
  });
  it('permite PWA instalado sem API adicional de tela cheia', async () => {
    vi.stubGlobal('screen', { orientation: { type: 'landscape-primary' } });
    vi.stubGlobal('navigator', { standalone: true });
    doc.documentElement.requestFullscreen = undefined!;
    expect(await enterPresentationFullscreen()).toBe('entered');
  });
  it('informa recusa de tela cheia em uma aba comum', async () => {
    vi.stubGlobal('screen', { orientation: { type: 'landscape-primary' } });
    requestFullscreen.mockRejectedValueOnce(new Error('Denied'));
    await expect(enterPresentationFullscreen()).rejects.toThrow('Denied');
  });
  it('preserva comportamento de tela cheia no computador', async () => {
    matchMedia.mockReturnValue({ matches: false });
    expect(await enterPresentationFullscreen()).toBe('entered');
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });
  it('sai da tela cheia sem alterar a orientação do sistema', async () => {
    vi.stubGlobal('screen', { orientation: { type: 'landscape-secondary', lock } });
    doc.fullscreenElement = element;
    await exitPresentationFullscreen();
    expect(doc.fullscreenElement).toBeNull();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(deviceOrientation()).toBe('landscape');
    expect(lock).not.toHaveBeenCalled();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
  it('sai do modo PWA sem chamar uma API de tela cheia inativa', async () => {
    await exitPresentationFullscreen();
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });
  it('propaga falha de saída para a interface permitir nova tentativa', async () => {
    doc.fullscreenElement = element;
    exitFullscreen.mockRejectedValueOnce(new Error('Denied'));
    await expect(exitPresentationFullscreen()).rejects.toThrow('Denied');
    expect(doc.fullscreenElement).toBe(element);
    expect(lock).not.toHaveBeenCalled();
  });
  it('pede giro real ao sistema antes da tela cheia no PWA instalado', async () => {
    vi.stubGlobal('navigator', { standalone: true });
    const orientation = { type: 'portrait-primary', lock, unlock: vi.fn() };
    vi.stubGlobal('screen', { orientation });
    lock.mockImplementationOnce(async (direction: string) => {
      expect(direction).toBe('landscape-primary');
      expect(requestFullscreen).not.toHaveBeenCalled();
      orientation.type = 'landscape-primary';
    });
    expect(await enterPresentationFullscreen()).toBe('entered');
    expect(deviceOrientation()).toBe('landscape');
    expect(lock).toHaveBeenCalledWith('landscape-primary');
  });
  it('mantém orientação manual quando o sistema recusa o pedido do PWA', async () => {
    vi.stubGlobal('navigator', { standalone: true });
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', lock } });
    lock.mockRejectedValueOnce(new Error('NotSupportedError'));
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
  it('não confunde promessa resolvida com orientação realmente horizontal', async () => {
    vi.stubGlobal('navigator', { standalone: true });
    const unlock = vi.fn();
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', lock, unlock } });
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    expect(unlock).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
  it('entra em tela cheia antes do pedido em uma aba comum', async () => {
    const orientation = { type: 'portrait-primary', lock, unlock: vi.fn() };
    vi.stubGlobal('screen', { orientation });
    lock.mockImplementationOnce(async () => {
      expect(doc.fullscreenElement).toBe(element);
      orientation.type = 'landscape-primary';
    });
    expect(await enterPresentationFullscreen()).toBe('entered');
  });
  it('sai da tela cheia temporária se a rotação da aba for recusada', async () => {
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', lock } });
    lock.mockRejectedValueOnce(new Error('NotSupportedError'));
    expect(await enterPresentationFullscreen()).toBe('rotate-device');
    expect(doc.fullscreenElement).toBeNull();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
  it('devolve controle ao sistema na saída sem solicitar outra direção', async () => {
    vi.stubGlobal('navigator', { standalone: true });
    const unlock = vi.fn();
    const orientation = { type: 'portrait-primary', lock, unlock };
    vi.stubGlobal('screen', { orientation });
    lock.mockImplementationOnce(async () => { orientation.type = 'landscape-primary'; });
    await enterPresentationFullscreen();
    await exitPresentationFullscreen();
    expect(unlock).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith('landscape-primary');
  });

});
