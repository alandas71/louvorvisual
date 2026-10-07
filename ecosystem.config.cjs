module.exports = {
  apps: [
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
