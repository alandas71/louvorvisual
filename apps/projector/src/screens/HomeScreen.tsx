'use client';

import type { AccountStatus } from '@louvorvisual/contracts';
import { useEffect, useState } from 'react';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { recoverableTitle } from '@/presentation/session';
import { Action } from '@/ui/Action';
import { Dialog } from '@/ui/Dialog';

function statusLine(account: AccountStatus | null): string {
  if (!account) return 'Tudo o que está neste aparelho funciona sem internet.';
  if (!account.signedIn) return 'Perfil deste aparelho · funciona sem internet';
  if (!account.online) return 'Sem conexão · o que já está neste aparelho continua disponível';
  if (account.sync.state === 'syncing') return 'Sincronizando com a equipe…';
  if (account.sync.state === 'error') return 'A sincronização falhou · o conteúdo local continua disponível';
  return 'Conectado à equipe';
}

/** Início: quatro cartões grandes, navegáveis pelo controle (planejamento/21). */
export function HomeScreen({ focusKey }: { focusKey: string | null }) {
  const app = useApp();
  const { host, recoverable } = app;
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [recentTitle, setRecentTitle] = useState<string | null>(null);
  const [asking, setAsking] = useState(recoverable !== null);
  const recentId = app.prefs.recentSetlistId;

  useEffect(() => {
    let current = true;
    host.request('account.status', {}).then(
      (status) => current && setAccount(status),
      () => undefined,
    );
    const off = host.on('account.changed', setAccount);
    return () => {
      current = false;
      off();
    };
  }, [host]);

  useEffect(() => {
    if (!recentId) return;
    let current = true;
    host.request('library.getSetlist', { setlistId: recentId }).then(
      (result) => current && setRecentTitle(result.setlist.title),
      // O repertório usado por último pode ter sido removido: o cartão só perde o destaque.
      () => current && setRecentTitle(null),
    );
    return () => {
      current = false;
    };
  }, [host, recentId]);

  const ref = useFocusLayer<HTMLElement>({ name: 'home', level: 0, repeat: 'directions', onBack: () => void host.request('host.exit', {}).catch(() => undefined) });
  const interrupted = recoverable ? recoverableTitle(recoverable) : null;
  const recover = () => recoverable && app.go({ name: 'presentation', request: { kind: 'recover', session: recoverable } });
  const discard = () => {
    if (!recoverable) return;
    void host.request('session.end', { sessionId: recoverable.sessionId }).catch(() => undefined);
    app.setRecoverable(null);
    setAsking(false);
  };
  const wanted = focusKey ?? 'home:setlists';

  return (
    <main className="screen" ref={ref} data-layer="home">
      <header className="screen-header">
        <h1>LouvorVisual</h1>
        <p data-testid="home-status">{statusLine(account)}</p>
      </header>
      <div className="cards">
        {recoverable && (
          <Action className="card card-wide" focusKey="home:recover" autoFocus={wanted === 'home:recover'} testId="card-recover" onSelect={() => setAsking(true)}>
            <span className="card-title">Apresentação interrompida</span>
            <span className="card-sub">{interrupted ?? 'Sessão anterior'} · recuperar em pausa ou descartar</span>
          </Action>
        )}
        <Action className="card" focusKey="home:setlists" autoFocus={wanted === 'home:setlists'} testId="card-setlists" onSelect={() => app.go({ name: 'setlists' })}>
          <span className="card-title">Apresentar repertório</span>
          <span className="card-sub" data-testid="recent-setlist">
            {recentId && recentTitle ? `Usado por último: ${recentTitle}` : 'Escolher um repertório deste aparelho'}
          </span>
        </Action>
        <Action className="card" focusKey="home:songs" autoFocus={wanted === 'home:songs'} testId="card-songs" onSelect={() => app.go({ name: 'songs' })}>
          <span className="card-title">Louvores locais</span>
          <span className="card-sub">Apresentar um louvor avulso</span>
        </Action>
        <Action className="card" focusKey="home:import" autoFocus={wanted === 'home:import'} testId="card-import" onSelect={() => app.go({ name: 'import' })}>
          <span className="card-title">Importar pacote</span>
          <span className="card-sub">Trazer um repertório do pendrive ou do armazenamento</span>
        </Action>
        <Action className="card" focusKey="home:settings" autoFocus={wanted === 'home:settings'} testId="card-settings" onSelect={() => app.go({ name: 'settings' })}>
          <span className="card-title">Configurações</span>
          <span className="card-sub">Equipe, sincronização e ajuste da imagem</span>
        </Action>
      </div>
      <p className="hint">Setas escolhem · OK abre · Voltar sai do aplicativo</p>

      {asking && recoverable && (
        <Dialog
          name="recover"
          testId="recover-dialog"
          title="Há uma apresentação interrompida"
          onBack={() => setAsking(false)}
          actions={
            <>
              <Action className="button" autoFocus testId="recover-resume" onSelect={recover}>
                Recuperar em pausa
              </Action>
              <Action className="button" testId="recover-discard" onSelect={discard}>
                Descartar
              </Action>
            </>
          }
        >
          <p>
            {interrupted ? `“${interrupted}” ` : 'A sessão anterior '}
            foi fechada sem encerrar. Ela volta no mesmo slide, em pausa; nenhum áudio toca sozinho.
          </p>
        </Dialog>
      )}
    </main>
  );
}
