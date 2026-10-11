import type { Metadata, Viewport } from 'next';
import { fontFaceCss } from '@/fonts';
import './globals.css';

export const metadata: Metadata = { title: 'LouvorVisual', icons: { icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%23181b22%22%2F%3E%3Cpath%20d%3D%22M12%2023V9l13-3v13M12%2014l13-3%22%20fill%3D%22none%22%20stroke%3D%22%237cc4ff%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%228%22%20cy%3D%2224%22%20r%3D%224%22%20fill%3D%22%237cc4ff%22%2F%3E%3Ccircle%20cx%3D%2221%22%20cy%3D%2220%22%20r%3D%224%22%20fill%3D%22%237cc4ff%22%2F%3E%3C%2Fsvg%3E" } };
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
