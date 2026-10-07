import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDocument } from '@/local';
import { sampleSong } from '@/local/testing';
import { DocumentSaver, TEXT_SAVE_DELAY_MS, type SaveStatus } from './saver';

const { song, arrangement } = sampleSong();
const songDoc = (title: string): LocalDocument => ({ entityType: 'song', document: { ...song, title } });
const arrangementDoc: LocalDocument = { entityType: 'arrangement', document: arrangement };

function setup(write = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined)) {
  const statuses: SaveStatus['state'][] = [];
  const saver = new DocumentSaver(write, (status) => statuses.push(status.state));
  const titles = () => write.mock.calls.map((call) => (call[0] as LocalDocument[]).map((item) => ('title' in item.document ? item.document.title : 'arranjo')));
  return { saver, write, statuses, titles };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DocumentSaver', () => {
  it('digitação espera o debounce e grava só a última versão', async () => {
    const { saver, write, statuses, titles } = setup();
    saver.schedule([songDoc('S')]);
    saver.schedule([songDoc('Sa')]);
    saver.schedule([songDoc('San')]);
    expect(statuses.at(-1)).toBe('saving');

    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(titles()).toEqual([['San']]);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('"salvo" só aparece depois da confirmação da gravação', async () => {
    let confirm = () => {};
    const { saver, statuses } = setup(vi.fn(() => new Promise<undefined>((resolve) => (confirm = () => resolve(undefined)))));
    saver.schedule([arrangementDoc], { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saving');
    expect(saver.hasUnsaved()).toBe(true);
    confirm();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saved');
    expect(saver.hasUnsaved()).toBe(false);
  });

  it('operação estrutural grava na hora e leva junto o texto pendente', async () => {
    const { saver, titles } = setup();
    saver.schedule([songDoc('Novo título')]);
    saver.schedule([arrangementDoc], { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(titles()).toEqual([['Novo título', 'arranjo']]);
  });

  it('flush conclui a escrita pendente antes de trocar de item', async () => {
    const { saver, write } = setup();
    saver.schedule([songDoc('Pendente')]);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS * 2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('gravações saem em ordem, uma de cada vez', async () => {
    const order: string[] = [];
    const { saver } = setup(
      vi.fn(async (documents: unknown) => {
        const [first] = documents as LocalDocument[];
        const title = first && 'title' in first.document ? first.document.title : '';
        await new Promise((resolve) => setTimeout(resolve, title === 'lenta' ? 50 : 1));
        order.push(title);
      }),
    );
    saver.schedule([songDoc('lenta')], { immediate: true });
    saver.schedule([songDoc('rápida')], { immediate: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['lenta', 'rápida']);
  });

  it('falha mantém o conteúdo para nova tentativa e não diz "salvo"', async () => {
    const write = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
    write.mockRejectedValueOnce(new Error('sem espaço'));
    const { saver, statuses, titles } = setup(write);
    saver.schedule([songDoc('Guardar')], { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('error');
    expect(statuses).not.toContain('saved');
    expect(saver.hasUnsaved()).toBe(true);

    await saver.flush();
    expect(titles()).toEqual([['Guardar'], ['Guardar']]);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('nova tentativa não troca uma versão mais nova pela que falhou', async () => {
    const write = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
    write.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('falhou');
    });
    const { saver, titles } = setup(write);
    saver.schedule([songDoc('antiga')], { immediate: true });
    saver.schedule([songDoc('nova')]);
    await vi.advanceTimersByTimeAsync(10);
    await saver.flush();
    expect(titles().at(-1)).toEqual(['nova']);
  });
});
