import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/app',
    name: 'LouvorVisual',
    short_name: 'LouvorVisual',
    description: 'Criação e apresentação de slides de louvores, com funcionamento offline.',
    lang: 'pt-BR',
    dir: 'ltr',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#0a0c11',
    theme_color: '#0a0c11',
    categories: ['music', 'productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Atalhos do ícone instalado; os três abrem documentos guardados para uso offline.
    shortcuts: [
      { name: 'Novo louvor', short_name: 'Novo', url: '/app?view=novo', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Repertórios', short_name: 'Repertórios', url: '/app?view=repertorios', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Janela de projeção', short_name: 'Projeção', url: '/projecao', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  };
}
