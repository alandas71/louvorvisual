import { expect, test } from '@playwright/test';
import { audioState, importAudio, type AudioFile } from './audio.helpers';
import { BrowserProfile, ProductionServer } from './helpers';
import { createSong, openOperator, operator } from './presentation.helpers';

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

const SAMPLE_RATE = 16_000;
const VOICE_STARTS_S = 4;

/**
 * Faixa sintética: introdução instrumental (tom grave) e depois uma "voz" —
 * pulsos glotais com vibrato passando por três formantes de vogal, em sílabas.
 * Nenhuma gravação de terceiros entra no repositório.
 */
function introThenVoice(name: string, seconds: number): AudioFile {
  const total = seconds * SAMPLE_RATE;
  const samples = new Float32Array(total);
  const formants = [
    { frequency: 700, bandwidth: 110, gain: 1 },
    { frequency: 1220, bandwidth: 120, gain: 0.5 },
    { frequency: 2600, bandwidth: 160, gain: 0.25 },
  ].map((formant) => {
    const r = Math.exp((-Math.PI * formant.bandwidth) / SAMPLE_RATE);
    return { gain: formant.gain, a1: 2 * r * Math.cos((2 * Math.PI * formant.frequency) / SAMPLE_RATE), a2: -r * r, y1: 0, y2: 0 };
  });
  let phase = 0;
  for (let index = 0; index < total; index += 1) {
    const t = index / SAMPLE_RATE;
    let value = 0.05 * Math.sin(2 * Math.PI * 110 * t);
    if (t >= VOICE_STARTS_S) {
      const pitch = 150 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t));
      phase += pitch / SAMPLE_RATE;
      const pulse = phase >= 1 ? 1 : 0;
      phase %= 1;
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t);
      for (const formant of formants) {
        const y = pulse + formant.a1 * formant.y1 + formant.a2 * formant.y2;
        formant.y2 = formant.y1;
        formant.y1 = y;
        value += 0.12 * formant.gain * syllable * y;
      }
    }
    samples[index] = value;
  }
  const buffer = Buffer.alloc(44 + total * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + total * 2, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(total * 2, 40);
  for (let index = 0; index < total; index += 1) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index] as number)) * 32767), 44 + index * 2);
  return { name, mimeType: 'audio/wav', buffer };
}

test('celular: "Letra →" pisca 1 s antes da primeira voz da faixa e volta a "Avançar" depois do clique', async () => {
  const context = await profile.open();
  const page = await context.newPage();
  await createSong(page, { durations: [null, null, null] });
  await importAudio(page, 'playback', introThenVoice('com-voz.wav', 12));

  await page.setViewportSize({ width: 390, height: 844 });
  await openOperator(page);
  const advance = page.getByTestId('advance');
  await expect(advance).toHaveText(/Avançar/);

  await page.getByRole('button', { name: '▶ Iniciar' }).click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'true');
  await expect(advance).toHaveText(/Letra/);
  await expect(advance).toHaveAttribute('data-voice-cue', 'false');

  // O aviso chega por volta de 1 s antes da voz: nem na introdução, nem depois de ela entrar.
  await expect(advance).toHaveAttribute('data-voice-cue', 'true', { timeout: 30_000 });
  const cuedAt = (await audioState(page)).positionMs;
  console.log(`aviso em ${Math.round(cuedAt)} ms; voz em ${VOICE_STARTS_S * 1000} ms`);
  expect(cuedAt).toBeGreaterThan(VOICE_STARTS_S * 1000 - 1600);
  expect(cuedAt).toBeLessThan(VOICE_STARTS_S * 1000 + 300);
  await expect(advance).toHaveClass(/lv-cue-blink/);

  await advance.click();
  await expect(operator(page)).toHaveAttribute('data-cover', 'false');
  await expect(advance).toHaveText(/Avançar/);
  await expect(advance).toHaveAttribute('data-voice-cue', 'false');
  await expect(advance).not.toHaveClass(/lv-cue-blink/);

  await context.close();
  expect(profile.consoleErrors.filter((text) => !/^Failed to load resource/.test(text))).toEqual([]);
});
