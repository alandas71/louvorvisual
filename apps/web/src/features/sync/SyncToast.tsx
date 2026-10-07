'use client';

import type { SyncProgress } from '@louvorvisual/sync';
import { AlertIcon, CheckIcon, SyncIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { visibleProgress } from '@/sync/engine';
import { useSyncEngine, useSyncStatus } from '@/sync/hooks';
import { formatBytes } from '../audio/htmlTransport';

const RESULT_TEXT = {
  done: 'Sincronização concluída.',
  failed: 'A sincronização falhou. O envio continua de onde parou na próxima tentativa.',
  offline: 'Sem conexão. O envio continua de onde parou quando ela voltar.',
} as const;

function describe(progress: SyncProgress): { title: string; detail: string } {
  if (progress.phase === 'documents') return { title: 'Enviando alterações', detail: `${progress.loaded} de ${progress.total}` };
  const verb = progress.phase === 'upload' ? 'Enviando' : 'Baixando';
  const title = progress.count > 1 ? `${verb} áudio ${progress.index} de ${progress.count}` : `${verb} áudio`;
  return { title, detail: `${formatBytes(progress.loaded)} de ${formatBytes(progress.total)}` };
}

/**
 * Andamento da sincronização em um aviso flutuante. A barra mostra só o que
 * de fato já foi transferido; ao terminar, o aviso diz se deu certo e some.
 */
export function SyncToast() {
  const current = useSyncEngine();
  const status = useSyncStatus(current?.engine ?? null);
  const progress = visibleProgress(status.progress);
  const result = progress ? null : status.transferResult;

  if (!progress && !result) return null;
  const text = progress ? describe(progress) : null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sync-toast"
      data-phase={progress?.phase ?? result}
      className="pointer-events-none fixed inset-x-4 bottom-20 z-[60] flex animate-rise justify-center pb-safe lg:inset-x-auto lg:bottom-6 lg:right-6"
    >
      <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-2 rounded-2xl border border-border-strong bg-surface-overlay p-4 text-sm shadow-pop">
        {progress && text ? (
          <>
            <div className="flex items-center gap-2">
              <SyncIcon size={16} className="shrink-0 animate-pulse-soft text-accent" />
              <span className="min-w-0 flex-1 truncate font-semibold">{text.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{progress.total > 0 ? `${Math.floor((progress.loaded / progress.total) * 100)}%` : ''}</span>
            </div>
            {progress.filename && <span className="truncate text-xs text-muted">{progress.filename}</span>}
            <progress className="h-1.5 w-full accent-accent" value={progress.loaded} max={Math.max(1, progress.total)} aria-label={text.title} />
            <span className="text-xs tabular-nums text-muted">{text.detail}</span>
          </>
        ) : (
          <div className={cn('flex items-center gap-2', result !== 'done' && 'text-danger')}>
            {result === 'done' ? <CheckIcon size={16} className="shrink-0 text-success" /> : <AlertIcon size={16} className="shrink-0" />}
            <span>{result && RESULT_TEXT[result]}</span>
          </div>
        )}
      </div>
    </div>
  );
}
