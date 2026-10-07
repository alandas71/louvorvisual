import type { NextConfig } from 'next';

// Alvo embarcado: só exportação estática. Não há servidor Next no aparelho,
// portanto nada de rewrites, headers, Server Actions ou otimização de imagem.
// O host serve os arquivos em https://appassets.androidplatform.net/assets/,
// e é esse o prefixo de todos os chunks, do CSS e das fontes.
const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/assets',
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default nextConfig;
