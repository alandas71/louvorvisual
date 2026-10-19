'use client';

import { buttonClass } from '@/components/ui/buttonStyles';
import { InstallIcon } from '@/components/ui/icons';
import { useOnline } from '@/pwa/device';
import { applyUpdate, useOfflineState } from '@/pwa/serviceWorker';
import { visibleProgress } from '@/sync/engine';
import { useSyncEngine, useSyncStatus } from '@/sync/hooks';

/** Avisa que uma versão já foi baixada, mas nunca tenta avisar sem rede. */
export function UpdateToast() {
  const offline = useOfflineState();
  const online = useOnline();
  const current = useSyncEngine();
  const sync = useSyncStatus(current?.engine ?? null);

  // Uma transferência em curso tem prioridade no mesmo espaço da tela; o aviso
  // de atualização volta assim que ela terminar.
  if (!online || !offline.updateWaiting || visibleProgress(sync.progress) || sync.transferResult) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-toast"
      className="fixed inset-x-4 bottom-20 z-[60] flex animate-rise justify-center pb-safe lg:inset-x-auto lg:bottom-6 lg:right-6"
    >
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border-strong bg-surface-overlay p-4 text-sm shadow-pop">
        <div className="flex items-center gap-2">
          <InstallIcon size={16} className="shrink-0 text-accent" />
          <span className="font-semibold">Uma nova versão está pronta.</span>
        </div>
        <p className="text-xs text-muted">Atualize quando não houver uma apresentação em andamento.</p>
        <div>
          <button type="button" className={buttonClass('primary', 'sm')} onClick={() => void applyUpdate()}>
            Atualizar agora
          </button>
        </div>
      </div>
    </div>
  );
}
