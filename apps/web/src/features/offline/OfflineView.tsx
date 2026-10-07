'use client';

import { useEffect, useState } from 'react';
import { applyUpdate, checkForUpdate, useOfflineState, type OfflineState } from '@/pwa/serviceWorker';
import { checkFontPack, type FontFaceCheck } from './fontCheck';
import { IntegritySection } from './IntegritySection';
import { LocalDataSection } from './LocalDataSection';

const PHASE_TEXT: Record<OfflineState['phase'], string> = {
  checking: 'Verificando…',
  unsupported: 'Este navegador não permite instalar o aplicativo para uso offline.',
  disabled: 'O uso offline só existe na versão de produção; este é o modo de desenvolvimento.',
  installing: 'Baixando o aplicativo para uso offline…',
  ready: 'Aplicativo pronto para abrir sem conexão.',
  failed: 'O aplicativo não está pronto para uso offline.',
};

const BLOCKED_TEXT = {
  'session-active': 'Há uma apresentação em andamento neste dispositivo (área do operador ou janela de projeção aberta). Encerre-a para atualizar.',
  'locks-unsupported': 'Este navegador não confirma se há apresentação aberta. Feche todas as janelas do aplicativo para atualizar.',
  'not-waiting': 'Não há versão nova aguardando.',
} as const;

const buttonClass =
  'rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60';

export function OfflineView() {
  const offline = useOfflineState();
  const [fonts, setFonts] = useState<FontFaceCheck[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void checkFontPack().then((result) => {
      if (current) setFonts(result);
    });
    return () => {
      current = false;
    };
  }, []);

  const fontsOk = fonts?.filter((font) => font.intact && font.loaded).length ?? 0;

  async function onUpdate() {
    setMessage(null);
    const reply = await applyUpdate();
    // Aceita: o service worker novo assume e esta janela recarrega sozinha.
    if (!reply.activated && reply.reason) setMessage(BLOCKED_TEXT[reply.reason]);
  }

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-bold">Disponível offline</h1>
        <p className="mt-1 text-muted">
          Situação do aplicativo e dos dados neste dispositivo: código, temas, fontes e louvores gravados.
        </p>
      </header>

      <section aria-labelledby="aplicativo" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-5">
        <h2 id="aplicativo" className="text-lg font-semibold">
          Aplicativo
        </h2>
        <p role="status" data-testid="offline-phase" data-phase={offline.phase}>
          {PHASE_TEXT[offline.phase]}
        </p>
        {offline.error && <p className="text-sm text-danger">{offline.error}</p>}
        {offline.version && (
          <p className="text-sm text-muted">
            Versão <span data-testid="app-version">{offline.version}</span> · {offline.cached} de {offline.expected} arquivos
            guardados.
          </p>
        )}
        {offline.updateWaiting && (
          <p className="text-sm" data-testid="update-waiting">
            Uma versão nova foi baixada. Ela só entra em uso quando você atualizar, fora de uma apresentação; depois disso, os dados deste dispositivo são
            atualizados para o formato novo sem apagar nada.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {offline.updateWaiting && (
            <button type="button" className={buttonClass} onClick={() => void onUpdate()}>
              Atualizar agora
            </button>
          )}
          {(offline.phase === 'ready' || offline.phase === 'failed') && (
            <button type="button" className={buttonClass} onClick={() => void checkForUpdate()}>
              Procurar versão nova
            </button>
          )}
        </div>
        {message && (
          <p role="alert" className="text-sm text-danger" data-testid="update-blocked">
            {message}
          </p>
        )}
      </section>

      <LocalDataSection buttonClassName={buttonClass} />

      <IntegritySection buttonClassName={buttonClass} />

      <section aria-labelledby="fontes-pacote" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-5">
        <h2 id="fontes-pacote" className="text-lg font-semibold">
          Pacote de fontes
        </h2>
        <p role="status" data-testid="font-summary" data-ok={fonts ? fontsOk : undefined} data-total={fonts?.length}>
          {fonts === null
            ? 'Conferindo os arquivos…'
            : fontsOk === fonts.length
              ? `As ${fonts.length} fontes estão íntegras e carregadas.`
              : `${fonts.length - fontsOk} de ${fonts.length} fontes falharam. A projeção usará uma fonte de sistema no lugar.`}
        </p>
        {fonts && (
          <ul className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            {fonts.map((font) => (
              <li key={font.file} className="flex justify-between gap-4" data-testid="font-check" data-file={font.file}>
                <span>
                  {font.family} {font.weight === 400 ? 'regular' : 'negrito'}
                </span>
                <span className={font.intact && font.loaded ? 'text-muted' : 'text-danger'}>
                  {!font.intact ? 'arquivo ausente ou alterado' : !font.loaded ? 'não carregou' : 'ok'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
