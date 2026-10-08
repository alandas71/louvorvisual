import { expect, test } from '@playwright/test';
import { firstVoiceStorageKey } from '../src/features/audio/lyricsStart';
import { audioState, importAudio, wavFile } from './audio.helpers';
import { BrowserProfile, ProductionServer } from './helpers';
import { createSong, openOperator, operator, readStore, SLIDE_TEXTS } from './presentation.helpers';

const server = new ProductionServer();
let profile: BrowserProfile;

test.beforeEach(async () => {
  profile = new BrowserProfile();
  await server.start();
});

test.afterEach(async () => {
  await server.stop();
  profile.remove();
});

const LYRICS_START_MS = 4000;

test('celular: "Letra →" pisca 1 s antes de a letra entrar na faixa e volta a "Avançar" depois do clique', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: [null, null, null] });
  await importAudio(page, 'playback', wavFile('playback.wav', 12));
  // O reconhecimento de fala (modelo baixado da rede) não roda aqui: o resultado da
  // análise desta faixa entra como se já estivesse guardado no aparelho.
  const [asset] = await readStore<{ sha256: string }>(page, 'assets');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key as string, value as string), [firstVoiceStorageKey(asset!.sha256, SLIDE_TEXTS.slice(0, 3).join('\n')), String(LYRICS_START_MS)]);

  await page.setViewportSize({ width: 390, height: 844 });
  await openOperator(page);
  const advance = page.getByTestId('advance');
  await expect(advance).toHaveText(/Avançar/);

  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expect(advance).toHaveText(/Letra/);
  // Na introdução o botão ainda não chama o operador.
  await expect(advance).toHaveAttribute('data-voice-cue', 'false');
  await expect(advance).not.toHaveClass(/lv-cue-blink/);

  await expect(advance).toHaveAttribute('data-voice-cue', 'true', { timeout: 30_000 });
  const cuedAt = (await audioState(page)).positionMs;
  expect(cuedAt).toBeGreaterThanOrEqual(LYRICS_START_MS - 1000);
  expect(cuedAt).toBeLessThan(LYRICS_START_MS);
  await expect(advance).toHaveClass(/lv-cue-blink/);

  await advance.click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'false');
  await expect(advance).toHaveText(/Avançar/);
  await expect(advance).toHaveAttribute('data-voice-cue', 'false');
  await expect(advance).not.toHaveClass(/lv-cue-blink/);

  await context.close();
  expect(profile.consoleErrors.filter((text) => !/^Failed to load resource/.test(text))).toEqual([]);
});
