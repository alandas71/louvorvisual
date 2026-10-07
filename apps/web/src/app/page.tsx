import { SkipToContent } from '@/components/ui/SkipToContent';

const linkClass =
  'rounded-lg border border-border-strong px-5 py-3 text-sm font-semibold hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// As entradas são documentos independentes guardados para uso offline. Links
// comuns carregam o documento inteiro; a navegação do Next pediria dados ao
// servidor, que pode não estar acessível.
export default function HomePage() {
  return (
    <>
      <SkipToContent />
      <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
        <h1 className="text-3xl font-bold">LouvorVisual</h1>
        <p className="text-muted">Prepare letras, gere slides e apresente louvores mesmo sem conexão.</p>
        <nav aria-label="Entradas do aplicativo" className="flex flex-wrap gap-3">
          <a href="/app" className={linkClass}>
            Abrir o aplicativo
          </a>
          <a href="/projecao" className={linkClass}>
            Abrir a projeção
          </a>
        </nav>
      </main>
    </>
  );
}
