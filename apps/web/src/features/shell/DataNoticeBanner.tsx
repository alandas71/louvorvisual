'use client';

import { buttonClass } from '@/components/ui/buttonStyles';
import { useDataNotice } from '@/local';

/**
 * Aviso sobre a conexão com os dados locais quando duas versões do aplicativo
 * estão abertas ao mesmo tempo. Nunca aparece nas janelas de apresentação.
 */
export function DataNoticeBanner() {
  const notice = useDataNotice();
  if (!notice) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-accent/60 bg-accent/10 px-4 py-3 text-sm leading-relaxed sm:px-6" data-testid="data-notice" data-kind={notice}>
      {notice === 'blocked' ? (
        <p className="min-w-0 flex-1">
          Os dados deste dispositivo precisam ser atualizados para esta versão, mas outra janela do LouvorVisual ainda está aberta com a versão anterior — talvez uma apresentação. Nada será
          interrompido: a atualização acontece sozinha quando aquela janela for fechada.
        </p>
      ) : (
        <>
          <p className="min-w-0 flex-1">
            O LouvorVisual foi atualizado em outra janela e os dados já estão no formato novo. O que você fez aqui foi gravado; recarregue esta janela para continuar.
          </p>
          <button type="button" className={buttonClass('primary', 'sm')} onClick={() => window.location.reload()}>
            Recarregar
          </button>
        </>
      )}
    </div>
  );
}
