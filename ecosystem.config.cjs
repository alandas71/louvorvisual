module.exports = {
  apps: [
    {
      name: 'louvorvisual-api',
      cwd: '/root/apps/louvorvisual',
      script: 'node',
      args: '--env-file=apps/api/.env --import tsx apps/api/src/server.ts',
    },
    {
      name: 'louvorvisual-web',
      cwd: '/root/apps/louvorvisual',
      script: 'npm',
      args: 'run start --workspace @louvorvisual/web',
      env: {
        NODE_ENV: 'production',
        PORT: '3022',
        // O navegador chama /api; o Next encaminha essas chamadas para a API
        // que roda no mesmo host. Pode ser substituída por BACKEND_URL no deploy.
        BACKEND_URL: process.env.BACKEND_URL ?? 'http://127.0.0.1:3021',
      },
    },
  ],
};
