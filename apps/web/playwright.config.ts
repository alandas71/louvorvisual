import { defineConfig, devices } from '@playwright/test';

// Os testes sobem e derrubam o próprio `next start`, porque a prova offline
// exige encerrar o servidor. Rodam em série: compartilham a porta e, nos testes
// de atualização, o arquivo public/sw.js. Requer `npm run build` antes.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/playwright-results.json' }],
  ],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
