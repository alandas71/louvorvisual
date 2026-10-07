import { expect, type Page } from '@playwright/test';
import { silentMp3Bytes, wavBytes } from '../src/lib/testAudio';
import { operator } from './presentation.helpers';

export type AudioFile = { name: string; mimeType: string; buffer: Buffer };

/** WAV sintético (tom senoidal baixo); `frequency` muda os bytes e, portanto, o hash. */
export function wavFile(name: string, seconds: number, frequency = 440): AudioFile {
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(wavBytes(seconds, { frequency })) };
}

export function mp3File(name: string, frames: number): AudioFile {
  return { name, mimeType: 'audio/mpeg', buffer: Buffer.from(silentMp3Bytes(frames)) };
}

const slot = (page: Page, kind: 'original' | 'playback') => page.getByTestId(`audio-${kind}`);

/** Escolhe o arquivo no editor; o tamanho aparece antes de qualquer gravação. */
export async function chooseAudio(page: Page, kind: 'original' | 'playback', file: AudioFile): Promise<void> {
  await page.getByTestId(`audio-import-${kind}`).locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByTestId(`audio-import-${kind}`).getByTestId('audio-chosen')).toContainText(file.name);
}

/** Importa pelo editor e espera a faixa ficar disponível e o arranjo salvo. */
export async function importAudio(page: Page, kind: 'original' | 'playback', file: AudioFile): Promise<void> {
  await chooseAudio(page, kind, file);
  await page.getByTestId(`audio-import-${kind}`).getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(slot(page, kind)).toHaveAttribute('data-state', 'bound');
  await expect(slot(page, kind).getByTestId('audio-track')).toHaveAttribute('data-present', 'true');
  await expect(slot(page, kind).getByTestId('audio-track')).toContainText(file.name);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

export async function setPolicy(page: Page, kind: 'original' | 'playback', policy: 'independent' | 'linked', offsetSeconds?: string): Promise<void> {
  if (offsetSeconds !== undefined) await slot(page, kind).getByLabel('Ponto de partida na gravação, em segundos').fill(offsetSeconds);
  await slot(page, kind).getByLabel('Relação com os slides').selectOption(policy);
  await expect(slot(page, kind).getByTestId('audio-track')).toHaveAttribute('data-policy', policy);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

type Probe = { seeking: number; plays: number; log: { index: number; status: string; audioMs: number; at: number }[] };

/**
 * Instrumenta o player único do operador: conta reposicionamentos e registra,
 * a cada troca de slide ou de estado, a posição da faixa naquele instante.
 */
export async function watchAudio(page: Page): Promise<void> {
  await expect(page.locator('audio[data-testid="session-audio"]')).toHaveCount(1);
  await page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="session-audio"]')!;
    const root = document.querySelector<HTMLElement>('[data-testid="operator"]')!;
    const probe: { seeking: number; plays: number; log: { index: number; status: string; audioMs: number; at: number }[] } = { seeking: 0, plays: 0, log: [] };
    (window as unknown as { lvAudio: typeof probe }).lvAudio = probe;
    audio.addEventListener('seeking', () => (probe.seeking += 1));
    audio.addEventListener('play', () => (probe.plays += 1));
    const read = () => `${root.dataset.index}|${root.dataset.status}`;
    let last = read();
    new MutationObserver(() => {
      const now = read();
      if (now === last) return;
      last = now;
      probe.log.push({ index: Number(root.dataset.index), status: root.dataset.status ?? '', audioMs: audio.currentTime * 1000, at: performance.now() });
    }).observe(root, { attributes: true, attributeFilter: ['data-index', 'data-status'] });
  });
}

export type AudioState = { positionMs: number; paused: boolean; ended: boolean; volume: number; seeking: number; plays: number; log: Probe['log'] };

export function audioState(page: Page): Promise<AudioState> {
  return page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="session-audio"]')!;
    const probe = (window as unknown as { lvAudio?: { seeking: number; plays: number; log: { index: number; status: string; audioMs: number; at: number }[] } }).lvAudio;
    return { positionMs: audio.currentTime * 1000, paused: audio.paused, ended: audio.ended, volume: audio.volume, seeking: probe?.seeking ?? -1, plays: probe?.plays ?? -1, log: probe?.log ?? [] };
  });
}

/** Espera a faixa chegar a uma posição, lendo o player (não o relógio do teste). */
export async function waitAudioAt(page: Page, positionMs: number, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await audioState(page)).positionMs, { timeout, intervals: [100] }).toBeGreaterThanOrEqual(positionMs);
}

export async function expectAudioPlaying(page: Page, playing: boolean): Promise<void> {
  await expect(operator(page)).toHaveAttribute('data-audio-playing', String(playing));
  expect((await audioState(page)).paused).toBe(!playing);
}

/** Troca os bytes guardados de todos os arquivos de áudio, direto no IndexedDB, sem passar pelo aplicativo. */
export function tamperAudioBlobs(page: Page, mode: 'delete' | 'corrupt'): Promise<number> {
  return page.evaluate(
    (how) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('louvorvisual');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('assetBlobs', 'readwrite');
          const store = transaction.objectStore('assetBlobs');
          let touched = 0;
          const all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result as { key: string; byteSize: number; blob: Blob }[]) {
              touched += 1;
              if (how === 'delete') store.delete(row.key);
              // Mesmo tamanho, outro conteúdo: só o hash denuncia.
              else store.put({ ...row, blob: new Blob([new Uint8Array(row.byteSize).fill(7)]) });
            }
          };
          transaction.oncomplete = () => {
            db.close();
            resolve(touched);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    mode,
  );
}
