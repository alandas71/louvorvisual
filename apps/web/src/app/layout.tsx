import type { Metadata, Viewport } from 'next';
import { fontFaceCss, fontFileUrl, fontPack } from '@/presentation/fontPack';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'LouvorVisual', template: '%s · LouvorVisual' },
  description: 'Criação e apresentação de slides de louvores, com funcionamento offline.',
  applicationName: 'LouvorVisual',
  appleWebApp: { capable: true, title: 'LouvorVisual', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
  icons: { apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: '#0a0c11',
  colorScheme: 'dark',
  // Instalado no celular, o aplicativo ocupa a tela toda; as margens seguras são tratadas no CSS.
  viewportFit: 'cover',
};

/**
 * A interface usa a Inter do pacote embutido sob outro nome de família, com
 * `swap`: o texto dos menus aparece na hora e nenhum arquivo novo é baixado.
 * As famílias dos slides continuam com `block` (ver fontFaceCss).
 */
function interfaceFontCss(): string {
  const inter = fontPack.fonts.find((font) => font.fontId === 'inter');
  if (!inter) return '';
  return inter.faces
    .map((face) => `@font-face{font-family:"Inter UI";font-style:${face.style};font-weight:${face.weight};font-display:swap;src:url("${fontFileUrl(face.file)}") format("woff2");unicode-range:${inter.unicodeRange}}`)
    .join('\n');
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        {/* Fontes do pacote embutido; nenhuma vem de serviço externo. */}
        <style id="lv-font-pack" dangerouslySetInnerHTML={{ __html: `${fontFaceCss()}\n${interfaceFontCss()}` }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
