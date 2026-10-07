'use client';

import type { AuthoringContext } from '@louvorvisual/domain';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { isPresentingWindow } from '@/lib/presenting';
import { currentAccount } from '@/sync/api';
import { activateTeamProfile, activeTeamProfile, listTeamProfiles, type TeamProfile } from '@/sync/profiles';
import { LocalDatabase, localDatabase } from './db';
import { classifyOpenError, ensureCompatible, guardConnection, LocalOpenError } from './open';
import { ensureProfile } from './repository';
import type { LocalProfile } from './schema';

export type LocalSession = {
  db: LocalDatabase;
  profile: LocalProfile;
  /** Conta e equipe deste perfil; `null` no perfil pessoal, que nunca é enviado. */
  team: TeamProfile | null;
  /** Contexto de autoria com o instante atual; pedir um novo a cada alteração. */
  context: () => AuthoringContext;
};

export type LocalSessionState = { status: 'loading' } | { status: 'ready'; session: LocalSession } | { status: 'error'; message: string };

let opening: Promise<LocalSession> | null = null;

/**
 * Aviso sobre a conexão com os dados locais, mostrado no topo do aplicativo:
 * `blocked` — a atualização dos dados espera outra janela fechar;
 * `superseded` — outra janela atualizou os dados e esta precisa recarregar.
 */
export type DataNotice = 'blocked' | 'superseded' | null;
let dataNotice: DataNotice = null;
const noticeListeners = new Set<() => void>();

/** Pedido para gravar agora o que estiver só na memória; o editor atende. */
export const FLUSH_EVENT = 'lv:flush';

function setDataNotice(next: DataNotice): void {
  dataNotice = next;
  if (next === 'superseded' && typeof window !== 'undefined') window.dispatchEvent(new Event(FLUSH_EVENT));
  for (const listener of noticeListeners) listener();
}

export function useDataNotice(): DataNotice {
  return useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    () => dataNotice,
    () => null,
  );
}


/**
 * Abre o banco do perfil em uso (aplicando migrações) e garante o perfil
 * local. Cada perfil de equipe tem o seu banco; nada aqui usa rede.
 */
export function openLocalSession(): Promise<LocalSession> {
  opening ??= (async () => {
    // O banco local é uma cópia offline, não a fonte da equipe. No primeiro
    // acesso deste navegador não há perfil nem documentos para abrir: se há
    // uma conta conectada, criamos a cópia local da equipe e o SyncEngine faz
    // bootstrap dela a partir do servidor. Sem rede/sessão, preservamos o
    // perfil pessoal para que o aplicativo continue abrindo offline.
    let team = await activeTeamProfile().catch(() => null);
    const hasLocalProfiles = team !== null || (await listTeamProfiles().catch(() => [])).length > 0;
    if (!hasLocalProfiles) {
      const account = await currentAccount().catch(() => null);
      const workspace = account?.workspaces[0];
      if (account && workspace) {
        team = await activateTeamProfile(account.user, workspace).catch(() => null);
      }
    }
    const db = team ? new LocalDatabase(team.dbName) : localDatabase();
    guardConnection(db, {
      isPresenting: isPresentingWindow,
      onSuperseded: () => setDataNotice('superseded'),
      onBlocked: () => setDataNotice('blocked'),
    });
    const newId = () => crypto.randomUUID();
    let profile: LocalProfile;
    try {
      await ensureCompatible(db);
      profile = await ensureProfile(db, newId, new Date().toISOString(), team ?? undefined);
    } catch (error) {
      throw classifyOpenError(error);
    }
    // A migração terminou (ou não era necessária): o aviso de espera some.
    if (dataNotice === 'blocked') setDataNotice(null);
    return {
      db,
      profile,
      team,
      context: () => ({ workspaceId: profile.workspaceId, userId: profile.userId, now: new Date().toISOString(), newId }),
    };
  })();
  // Uma falha não fica guardada: a próxima tentativa abre de novo.
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

export function useLocalSession(): LocalSessionState {
  const [state, setState] = useState<LocalSessionState>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    openLocalSession().then(
      (session) => current && setState({ status: 'ready', session }),
      (error: unknown) => current && setState({ status: 'error', message: error instanceof LocalOpenError ? error.message : 'Não foi possível abrir os dados deste dispositivo.' }),
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}
