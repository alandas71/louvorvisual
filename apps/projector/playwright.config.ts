import { defineConfig } from '@playwright/test';

// Os testes rodam sobre o bundle final (`npm run build`), servido por
// scripts/serve-static.mjs no mesmo caminho que o host Android usa (/assets/).
// O servidor é só de arquivos e envia uma CSP que bloqueia qualquer outra origem.
const PORT = 3321;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Saída do projetor alvo.
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node scripts/serve-static.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/assets/index.html`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
