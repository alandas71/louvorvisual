module.exports = {
  apps: [
    {
      name: 'louvorvisual-api',
      cwd: '/root/apps/louvorvisual',
      script: 'node',
      args: '--env-file=apps/api/.env apps/api/dist/server.js',
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
