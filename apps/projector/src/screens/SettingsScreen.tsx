'use client';

import type { AccountStatus } from '@louvorvisual/contracts';
import { BUNDLED_FONTS, THEME_PRESETS } from '@louvorvisual/domain';
import { nextRotation } from '@louvorvisual/presentation';
import { useEffect, useState } from 'react';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action, Adjust } from '@/ui/Action';
import { LandscapeIcon, PortraitIcon } from '@/ui/icons';
import { hostErrorText } from './shared';

const SYNC_TEXT: Record<AccountStatus['sync']['state'], string> = { disabled: 'Só neste aparelho', idle: 'Em dia', syncing: 'Sincronizando…', error: 'A última sincronização falhou' };
const SAFE_AREA_STEP = 0.5;
const SAFE_AREA_MAX = 10;

/**
 * Configurações do aparelho. Fica fora da apresentação: quem olha a projeção
 * vê esta tela, por isso ela só existe com a sessão encerrada, e a entrada na
 * equipe acontece na tela nativa do host — nenhuma credencial passa por aqui.
 */
export function SettingsScreen() {
  const app = useApp();
  const { host, prefs, info } = app;
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    host.request('account.status', {}).then(
      (status) => current && setAccount(status),
      (error: unknown) => current && setNote(hostErrorText(error)),
    );
    const off = host.on('account.changed', setAccount);
    return () => {
      current = false;
      off();
    };
  }, [host]);

  const ref = useFocusLayer<HTMLElement>({ name: 'settings', level: 0, repeat: 'directions', onBack: () => app.back() });

  const signIn = () => {
    setNote('Use a tela de entrada do aparelho…');
    host.request('account.signIn', {}).then(
      ({ status }) => setNote(status === 'signed-in' ? 'Conectado à equipe.' : status === 'offline' ? 'Sem conexão. A biblioteca local continua disponível.' : status === 'cancelled' ? 'Entrada cancelada.' : 'Não foi possível entrar. Confira os dados e tente de novo.'),
      (error: unknown) => setNote(hostErrorText(error)),
    );
  };
  const signOut = () => void host.request('account.signOut', {}).then(() => setNote('Este aparelho saiu da equipe. O conteúdo local não foi apagado.'), (error: unknown) => setNote(hostErrorText(error)));
  const sync = () => void host.request('account.syncNow', {}).then(({ started }) => setNote(started ? 'Sincronização iniciada.' : 'Sem conexão. A sincronização fica para depois.'), (error: unknown) => setNote(hostErrorText(error)));
  const stepSafeArea = (direction: 1 | -1) => app.updatePrefs({ safeAreaPercent: Math.min(SAFE_AREA_MAX, Math.max(0, Math.round((prefs.safeAreaPercent + direction * SAFE_AREA_STEP) * 10) / 10)) });

  return (
    <main className="screen" ref={ref} data-layer="settings">
      <header className="screen-header">
        <h1>Configurações</h1>
        <p data-testid="settings-note">{note ?? ''}</p>
      </header>
      <div className="columns">
        <section className="panel" aria-label="Equipe e sincronização">
          <h2>Equipe e sincronização</h2>
          <p data-testid="account-summary">
            {!account ? 'Lendo…' : account.signedIn ? `${account.teamName ?? 'Equipe'} · ${account.online ? SYNC_TEXT[account.sync.state] : 'sem conexão'}` : 'Perfil deste aparelho. Entre na equipe para receber os repertórios compartilhados.'}
          </p>
          {account?.signedIn && account.sync.conflicts > 0 && <p className="alert">Há {account.sync.conflicts} conflito(s) para resolver no computador.</p>}
          {account?.signedIn ? (
            <>
              <Action className="button" autoFocus testId="settings-sync" onSelect={sync}>
                Sincronizar agora
              </Action>
              <Action className="button" testId="settings-signout" onSelect={signOut}>
                Sair da equipe neste aparelho
              </Action>
            </>
          ) : (
            <Action className="button" autoFocus testId="settings-signin" onSelect={signIn}>
              Entrar na equipe
            </Action>
          )}
        </section>

        <section className="panel" aria-label="Imagem">
          <h2>Imagem</h2>
          <p>Se o projetor corta as bordas, aumente a margem até o contorno desta tela aparecer inteiro.</p>
          <Adjust label="Margem de segurança" value={`${prefs.safeAreaPercent.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} %`} testId="settings-safe-area" onStep={stepSafeArea} />
          <Action className="button" testId="settings-rotation" onSelect={() => app.updatePrefs({ rotation: nextRotation(prefs.rotation) })}>
            <span>{prefs.rotation === 0 ? 'Vertical' : 'Horizontal'}</span>
            <span className="button-value">{prefs.rotation === 0 ? <PortraitIcon /> : <LandscapeIcon />}</span>
          </Action>
        </section>

        <section className="panel" aria-label="Sobre">
          <h2>Sobre</h2>
          <p data-testid="settings-about">
            LouvorVisual {info.appVersion} · {BUNDLED_FONTS.length} famílias de fontes (pacote v{info.fontPackVersion}) · {THEME_PRESETS.length} temas escuros, todos neste aparelho
          </p>
        </section>
      </div>
      <p className="hint">←/→ ajustam o valor em foco · Voltar retorna ao início</p>
    </main>
  );
}
