'use client';

import type { HostResult, ProjectorPrefs, RecoverableSession, SessionContext, SetlistEntry } from '@louvorvisual/contracts';
import type { Uuid } from '@louvorvisual/domain';
import { createContext, useContext } from 'react';
import type { HostClient } from './host/client';

export type PresentationRequest =
  | { kind: 'start'; arrangementId: Uuid; context: SessionContext; /** Itens do repertório, para "Próximo louvor". */ queue: SetlistEntry[] }
  | { kind: 'recover'; session: RecoverableSession };

export type Screen =
  | { name: 'home' }
  | { name: 'setlists' }
  | { name: 'setlist'; setlistId: Uuid }
  | { name: 'songs' }
  | { name: 'import' }
  | { name: 'settings' }
  | { name: 'presentation'; request: PresentationRequest };

export type AppServices = {
  host: HostClient;
  info: HostResult<'host.info'>;
  prefs: ProjectorPrefs;
  updatePrefs(changes: Partial<ProjectorPrefs>): void;
  /** Sessão interrompida ainda não recuperada nem descartada. */
  recoverable: RecoverableSession | null;
  setRecoverable(session: RecoverableSession | null): void;
  go(screen: Screen): void;
  replace(screen: Screen): void;
  /** Volta à tela anterior; `focusKey` escolhe o item que recebe o foco nela. */
  back(focusKey?: string): void;
};

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const value = useContext(AppContext);
  if (!value) throw new Error('Fora do aplicativo.');
  return value;
}
