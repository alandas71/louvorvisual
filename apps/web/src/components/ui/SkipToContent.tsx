'use client';

export function SkipToContent() {
  return (
    <a
      href="#main-content"
      // A âncora sozinha rola a página, mas não tira o foco do atalho: o próximo Tab
      // voltaria ao menu. O foco vai para o conteúdo de forma explícita.
      onClick={(event) => {
        const main = document.getElementById('main-content');
        if (!main) return;
        event.preventDefault();
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        // O anel de foco em volta da página inteira não informa nada.
        main.style.outline = 'none';
        main.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-5 focus:py-3 focus:font-semibold focus:text-surface focus:outline-none"
    >
      Pular para o conteúdo principal
    </a>
  );
}
