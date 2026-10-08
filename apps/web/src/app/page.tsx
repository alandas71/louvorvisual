import Image from 'next/image';
import { ChevronRightIcon, LibraryIcon, ProjectorIcon } from '@/components/ui/icons';
import { SkipToContent } from '@/components/ui/SkipToContent';
import { BrandMark } from '@/features/shell/BrandMark';

const entryClass =
  'group flex items-center gap-4 rounded-2xl border p-5 transition-[border-color,background-color,transform] duration-150 active:scale-[0.99] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// As entradas são documentos independentes guardados para uso offline. Links
// comuns carregam o documento inteiro; a navegação do Next pediria dados ao
// servidor, que pode não estar acessível.
export default function HomePage() {
  return (
    <>
      <SkipToContent />
      <div className="lv-stage flex min-h-dvh flex-col overflow-x-clip">
        <main id="main-content" className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-12 px-5 py-12 sm:px-8 lg:py-20">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
            <div className="flex flex-col gap-6">
              <p className="flex items-center gap-3 text-base font-bold tracking-tight">
                <BrandMark size={40} />
                LouvorVisual
              </p>
              <h1 className="text-4xl font-bold leading-[1.08] sm:text-5xl">
                A letra certa na tela, <span className="text-accent">na hora certa.</span>
              </h1>
              <nav aria-label="Entradas do aplicativo" className="grid max-w-xl gap-3">
                <a href="/app" className={`${entryClass} border-accent bg-accent text-accent-ink shadow-glow hover:bg-accent-strong`}>
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-ink/10">
                    <LibraryIcon size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-bold">Abrir o aplicativo</span>
                    <span className="block text-sm">Biblioteca e operador</span>
                  </span>
                  <ChevronRightIcon className="shrink-0 transition-transform group-hover:translate-x-1" />
                </a>
                <a href="/projecao" className={`${entryClass} border-border-strong bg-surface-raised hover:border-muted`}>
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-overlay text-accent">
                    <ProjectorIcon size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-bold">Abrir a projeção</span>
                    <span className="block text-sm text-muted">A janela que o público vê</span>
                  </span>
                  <ChevronRightIcon className="shrink-0 text-muted transition-transform group-hover:translate-x-1" />
                </a>
              </nav>
            </div>

            {/* Marca oficial do LouvorVisual. */}
            <div aria-hidden="true" className="relative mx-auto w-full max-w-md lg:max-w-none">
              <div className="absolute -inset-6 rounded-[2.5rem] bg-accent/10 blur-3xl" />
              <div className="relative overflow-hidden rounded-3xl border border-border-strong bg-surface-raised shadow-pop">
                <Image
                  src="/brand/louvorvisual.png"
                  alt=""
                  width={1254}
                  height={1254}
                  priority
                  className="h-auto w-full"
                />
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
