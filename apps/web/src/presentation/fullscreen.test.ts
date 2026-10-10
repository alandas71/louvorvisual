import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterPresentationFullscreen, exitPresentationFullscreen } from './fullscreen';

describe('orientação da apresentação espelhada', () => {
  const events = new EventTarget();
  const element = {};
  const lock = vi.fn<(orientation: string) => Promise<void>>(async () => {});
  const unlock = vi.fn();
  const doc = {
    fullscreenElement: null as object | null,
    documentElement: { requestFullscreen: vi.fn(async () => { doc.fullscreenElement = element; }) },
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
      events.dispatchEvent(new Event('fullscreenchange'));
    }),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('screen', { orientation: { lock, unlock } });
  });
  afterEach(async () => {
    await exitPresentationFullscreen();
    vi.unstubAllGlobals();
  });

  it('entra em tela cheia antes de pedir paisagem', async () => {
    lock.mockImplementationOnce(async () => { expect(doc.fullscreenElement).toBe(element); });
    await enterPresentationFullscreen();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('mantém tela cheia quando o navegador rejeita a orientação', async () => {
    lock.mockRejectedValueOnce(new Error('NotSupportedError'));
    await expect(enterPresentationFullscreen()).resolves.toBeUndefined();
    expect(doc.fullscreenElement).toBe(element);
  });

  it('aceita navegadores sem API de orientação', async () => {
    vi.stubGlobal('screen', {});
    await expect(enterPresentationFullscreen()).resolves.toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
    expect(doc.fullscreenElement).toBe(element);
  });

  it('informa falha de tela cheia sem tentar travar orientação', async () => {
    doc.documentElement.requestFullscreen.mockRejectedValueOnce(new Error('Denied'));
    await expect(enterPresentationFullscreen()).rejects.toThrow('Denied');
    expect(lock).not.toHaveBeenCalled();
  });

  it('libera orientação ao sair pelo navegador, sem repetir a liberação', async () => {
    await enterPresentationFullscreen();
    doc.fullscreenElement = null;
    events.dispatchEvent(new Event('fullscreenchange'));
    events.dispatchEvent(new Event('fullscreenchange'));
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('libera orientação ao sair pelo botão de tela cheia', async () => {
    await enterPresentationFullscreen();
    await exitPresentationFullscreen();
    expect(doc.fullscreenElement).toBeNull();
    expect(unlock).toHaveBeenCalledOnce();
  });
});
