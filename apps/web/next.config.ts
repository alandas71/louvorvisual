import type { NextConfig } from 'next';

// Origem pública única: o navegador chama /api e o Next encaminha à API.
// Sem BACKEND_URL não há encaminhamento; o aplicativo local não depende dele.
// A produção publicada executa a API no mesmo servidor, restrita a localhost.
// Assim, um novo build não perde o login se a variável de deploy for omitida.
const backendUrl = (process.env.BACKEND_URL ?? (process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:3021' : undefined))?.replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  rewrites() {
    if (!backendUrl) return [];
    // BACKEND_URL é a origem da API (ex.: http://localhost:3021); as rotas dela
    // já começam em /api/v1, então o caminho é encaminhado inteiro.
    return [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }];
  },
  headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // O navegador precisa reconsultar o service worker para achar versões novas.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        // O caminho inclui a versão do pacote; os arquivos nunca mudam.
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // Runtime do reconhecimento de fala: também versionado no caminho.
        source: '/asr/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
