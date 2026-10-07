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
      },
    },
  ],
};
