'use client';

import { setLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { useSyncEngine, useSyncStatus } from '@/sync/hooks';
import { connectionSummary } from './labels';

/** Estado de conexão e pendências, sempre visível na navegação. */
export function SyncStatusChip() {
  const current = useSyncEngine();
  const status = useSyncStatus(current?.engine ?? null);
  if (!current) return null;
  const { team } = current.session;
  const pending = status.summary?.pending ?? 0;
  const conflicts = status.summary?.conflicts ?? 0;
  const attention = conflicts > 0 || status.connection === 'revoked' || status.connection === 'identity-mismatch' || status.connection === 'auth-required';
  return (
    <a
      href="/app?view=sync"
      data-testid="sync-chip"
      data-connection={status.connection}
      data-pending={status.summary ? pending : undefined}
      data-conflicts={status.summary ? conflicts : undefined}
      data-profile={team ? 'team' : 'personal'}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        setLocalQuery({ view: 'sync', song: null, arranjo: null, repertorio: null, item: null, conflito: null });
      }}
      className={cn(
        'mb-3 block rounded-lg border px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        attention ? 'border-danger text-danger' : 'border-border text-muted hover:text-foreground',
      )}
    >
      <span className="block truncate font-semibold text-foreground">{team ? team.workspaceName : 'Perfil pessoal'}</span>
      <span className="block">{connectionSummary(status.connection, pending, conflicts).short}</span>
      {team && pending > 0 && <span className="block">{pending === 1 ? '1 alteração pendente' : `${pending} alterações pendentes`}</span>}
      {conflicts > 0 && <span className="block font-semibold">{conflicts === 1 ? '1 conflito' : `${conflicts} conflitos`}</span>}
    </a>
  );
}
