import type { Metadata, Viewport } from 'next';
import { fontFaceCss } from '@/presentation/fontPack';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'LouvorVisual', template: '%s · LouvorVisual' },
  description: 'Criação e apresentação de slides de louvores, com funcionamento offline.',
};

export const viewport: Viewport = {
  themeColor: '#0f1115',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        {/* Fontes do pacote embutido; nenhuma vem de serviço externo. */}
        <style id="lv-font-pack" dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
