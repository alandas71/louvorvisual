import type { Metadata, Viewport } from 'next';
import { fontFaceCss } from '@/fonts';
import './globals.css';

export const metadata: Metadata = { title: 'LouvorVisual' };
export const viewport: Viewport = { themeColor: '#000000', colorScheme: 'dark' };

// Único documento do bundle: gerado no build, sem dado de servidor. Tudo o que
// depende do aparelho chega depois, pela ponte com o host.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        {/* Fontes do pacote embarcado; nenhuma vem de fora do APK. */}
        <style id="lv-font-pack" dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
