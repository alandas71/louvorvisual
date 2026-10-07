'use client';

import { Loading } from '@/components/ui/PageHeader';
import { listOpenConflicts, listPending, type ConflictRecord, type PendingItem } from '@louvorvisual/sync';
import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import type { LocalSession } from '@/local/session';
import type { SyncEngine } from '@/sync/engine';
import { buildPendingExport, downloadJson } from '@/sync/exportPending';
import { useLibraryVersion, useSyncEngine, useSyncStatus } from '@/sync/hooks';
import { ConflictPanel } from './ConflictPanel';
import { BLOCK_TEXT, CONFLICT_TEXT, connectionSummary, dateTime, ENTITY_TEXT, PHASE_TEXT, SUSPENDED_TEXT } from './labels';

const sectionClass = 'flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-6';

export function SyncView() {
  const current = useSyncEngine();
  if (!current) return <Loading>Abrindo os dados deste dispositivo…</Loading>;
  return <Sync session={current.session} engine={current.engine} />;
}

function titleOfConflict(conflict: ConflictRecord): string {
  const local = conflict.local as Record<string, unknown>;
  return String(local.title ?? local.name ?? local.filename ?? conflict.entityId);
}

function Sync({ session, engine }: { session: LocalSession; engine: SyncEngine }) {
  const status = useSyncStatus(engine);
  const version = useLibraryVersion();
  const selected = useLocalQuery().get('conflito');
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const { team } = session;
  const { connection, summary, lastOutcome, nextRetryAt } = status;

  const reload = useCallback(
    () =>
      Promise.all([listPending(engine.storage, new Date().toISOString()), listOpenConflicts(engine.storage)]).then(([items, open]) => {
        setPending(items);
        setConflicts(open);
      }),
    [engine],
  );
  // As listas acompanham cada mudança de estado do motor e da biblioteca.
  useEffect(() => {
    void reload();
  }, [reload, status, version]);

  const open = conflicts.find((conflict) => conflict.id === selected) ?? null;
  const text = connectionSummary(connection, summary?.pending ?? 0, summary?.conflicts ?? 0);
  const suspended = SUSPENDED_TEXT[connection];
  const waiting = (pending ?? []).filter((item) => item.phase !== 'conflict');

  async function exportPending() {
    downloadJson(`louvorvisual-pendencias-${new Date().toISOString().slice(0, 10)}.json`, await buildPendingExport(session, engine.storage));
  }

  return (
    <div className="flex flex-col gap-8" data-testid="sync-view">
      <header>
        <h1 className="text-[1.75rem] font-bold leading-tight md:text-3xl">Sincronização</h1>
      </header>

      <section aria-labelledby="sync-estado" className={sectionClass}>
        <h2 id="sync-estado" className="text-lg font-bold">
          Conexão
        </h2>
        <p
          role="status"
          data-testid="sync-status"
          data-connection={connection}
          data-leader={status.leader}
          data-cycles={status.cycles}
          data-pending={summary?.pending}
          data-conflicts={summary?.conflicts}
          data-in-transit={summary?.inTransit}
          data-cursor={summary?.cursor ?? ''}
          data-last-sync={summary?.lastSyncAt ?? ''}
        >
          <strong>{text.short}.</strong> {text.long}
        </p>
        {connection === 'error' && lastOutcome?.error && (
          <p className="text-sm text-danger" data-testid="sync-error" data-code={lastOutcome.error.code}>
            {lastOutcome.error.message} ({lastOutcome.error.code})
          </p>
        )}
        {nextRetryAt !== null && <p className="text-sm text-muted">Nova tentativa automática por volta de {dateTime.format(new Date(nextRetryAt))}.</p>}
        {summary?.lastSyncAt && <p className="text-sm text-muted">Última sincronização completa: {dateTime.format(new Date(summary.lastSyncAt))}.</p>}
        {lastOutcome && lastOutcome.downloadsDeferred > 0 && <p className="text-sm text-muted">{lastOutcome.downloadsDeferred} download(s) de áudio adiados enquanto há uma apresentação aberta.</p>}

        {connection === 'revoked' && (
          <div role="alert" data-testid="sync-revoked" className="flex flex-col gap-2 rounded-lg border border-danger p-4 text-sm">
            <p className="font-semibold text-danger">Acesso a esta equipe revogado</p>
            <p>
              O servidor recusou este perfil. Nada mais é enviado nem recebido deste espaço. {(summary?.pending ?? 0) === 1 ? 'A alteração pendente continua salva' : `As ${summary?.pending ?? 0} alterações pendentes continuam salvas`} neste dispositivo e <strong>não</strong> {(summary?.pending ?? 0) === 1 ? 'será publicada' : 'serão publicadas'} com outra conta.
            </p>
            <p>Você pode exportar as pendências e, se quiser, remover os dados locais deste perfil em &ldquo;Conta e equipe&rdquo;. O que já está preparado neste dispositivo continua abrindo.</p>
          </div>
        )}
        {connection === 'identity-mismatch' && (
          <p role="alert" data-testid="sync-mismatch" className="rounded-lg border border-danger p-4 text-sm">
            A sessão online é de outra conta. Para sincronizar este perfil, entre como {team?.userEmail} em &ldquo;Conta e equipe&rdquo;, ou troque para o perfil da conta conectada.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          {team && (
            <button type="button" className={buttonClass('primary')} data-testid="sync-now" onClick={() => engine.syncNow()} disabled={connection === 'syncing'}>
              Sincronizar agora
            </button>
          )}
          <button type="button" className={buttonClass('secondary')} onClick={() => setLocalQuery({ view: 'conta', conflito: null })}>
            Conta e equipe
          </button>
          {(summary?.pending ?? 0) > 0 && (
            <button type="button" className={buttonClass('secondary')} data-testid="export-pending" onClick={() => void exportPending()}>
              Exportar pendências
            </button>
          )}
        </div>
      </section>

      {message && (
        <p role="status" data-testid="sync-message" className="text-sm">
          {message}
        </p>
      )}

      <section aria-labelledby="sync-conflitos" className={sectionClass}>
        <h2 id="sync-conflitos" className="text-lg font-bold">
          Conflitos
        </h2>
        {conflicts.length === 0 ? (
          <p className="text-muted" data-testid="conflicts-empty">
            Nenhum conflito aguardando decisão.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {conflicts.map((conflict) => (
              <li key={conflict.id} data-testid="conflict-row" data-conflict-id={conflict.id} data-kind={conflict.kind} data-entity-id={conflict.entityId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {ENTITY_TEXT[conflict.entityType]}: {titleOfConflict(conflict)}
                  </p>
                  <p className="text-sm text-muted">{CONFLICT_TEXT[conflict.kind]}</p>
                </div>
                <button type="button" className={buttonClass(open?.id === conflict.id ? 'secondary' : 'primary', 'sm')} onClick={() => setLocalQuery({ conflito: open?.id === conflict.id ? null : conflict.id })}>
                  {open?.id === conflict.id ? 'Fechar' : 'Comparar e resolver'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <ConflictPanel
            key={`${open.id}:${open.remoteRevision}`}
            session={session}
            engine={engine}
            conflict={open}
            onDone={(text) => {
              setMessage(text);
              setLocalQuery({ conflito: null });
              void reload();
            }}
          />
        )}
      </section>

      <section aria-labelledby="sync-pendencias" className={sectionClass}>
        <h2 id="sync-pendencias" className="text-lg font-bold">
          Pendências
        </h2>
        {pending === null ? (
          <Loading>Carregando…</Loading>
        ) : waiting.length === 0 ? (
          <p className="text-muted" data-testid="pending-empty">
            {team ? 'Nada aguardando envio.' : 'Nada a enviar.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="pending-list">
            {waiting.map((item) => (
              <li key={item.key} data-testid="pending-row" data-key={item.key} data-phase={item.phase} data-generation={item.localGeneration} data-revision={item.serverRevision ?? ''} data-op-id={item.opId ?? ''} data-attempts={item.attempts} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-semibold">
                  {ENTITY_TEXT[item.entityType]}: {item.title}
                  {item.deleted && <span className="ml-2 font-normal text-muted">(exclusão)</span>}
                </p>
                <p className={item.phase === 'blocked' || item.phase === 'suspended' ? 'text-danger' : 'text-muted'}>
                  {!team ? 'Salvo só neste dispositivo' : suspended && item.phase !== 'blocked' && item.phase !== 'suspended' ? suspended : PHASE_TEXT[item.phase]}
                  {item.code && ` — ${BLOCK_TEXT[item.code] ?? item.code}`}
                  {item.phase === 'sending' && item.attempts > 1 && ` (tentativa ${item.attempts}, mesma operação)`}
                </p>
                <p className="text-xs text-muted">
                  Geração local {item.localGeneration} · {item.serverRevision ? `base: revisão ${item.serverRevision}` : 'ainda sem revisão no servidor'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
