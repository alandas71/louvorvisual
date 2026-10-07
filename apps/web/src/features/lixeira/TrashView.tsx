'use client';

import { EmptyState, Loading, noticeClass, pillClass } from '@/components/ui/PageHeader';
import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { ClockIcon, TrashIcon } from '@/components/ui/icons';
import { setLocalQuery } from '@/lib/localQuery';
import { listHistory, listTrash, RecoveryError, restoreFromTrash, restoreRevision, TRASH_RETENTION_DAYS, useLocalSession, type HistoryEntry, type LocalSession, type RevisionReason, type TrashItem } from '@/local';
import { LIBRARY_CHANGED_EVENT } from '@/sync/engine';
import { useLibraryVersion } from '@/sync/hooks';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const DAY_MS = 24 * 60 * 60 * 1000;

const TYPE_TEXT = { song: 'Louvor', arrangement: 'Arranjo', setlist: 'Repertório' } as const;

const REASON_TEXT: Record<RevisionReason, string> = {
  edit: 'Como estava antes de uma edição',
  delete: 'Como estava antes de ser excluído',
  regenerate: 'Como estava antes de regenerar os slides',
  restore: 'Versão substituída por uma restauração',
  corrupted: 'Registro ilegível retirado por um reparo',
  'conflict-local': 'Minha versão em um conflito com a equipe',
  'conflict-remote': 'Versão da equipe em um conflito',
  'bootstrap-missing': 'Retirado pela equipe',
};

export function TrashView() {
  const local = useLocalSession();
  if (local.status === 'loading') return <Loading>Abrindo a lixeira…</Loading>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  return <Trash session={local.session} />;
}

/**
 * Lixeira e histórico locais. Restaurar é sempre uma alteração nova: a versão
 * em uso é guardada antes, e em um perfil de equipe o resultado passa pela
 * sincronização como qualquer edição.
 */
function Trash({ session }: { session: LocalSession }) {
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** Instante da última leitura: a idade dos itens é calculada em relação a ele. */
  const [loadedAt, setLoadedAt] = useState(0);
  const version = useLibraryVersion();
  const workspaceId = session.profile.workspaceId;

  const reload = useCallback(
    () =>
      Promise.all([listTrash(session.db, workspaceId), listHistory(session.db, workspaceId)]).then(([nextTrash, nextHistory]) => {
        setLoadedAt(Date.now());
        setTrash(nextTrash);
        setHistory(nextHistory);
      }),
    [session, workspaceId],
  );
  useEffect(() => {
    void reload();
  }, [reload, version]);

  async function run(action: () => Promise<string>) {
    setMessage(null);
    try {
      const text = await action();
      await reload();
      // As outras vistas e janelas deste perfil recarregam as suas listas.
      window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
      setMessage({ kind: 'ok', text });
    } catch (reason) {
      setMessage({ kind: 'error', text: reason instanceof RecoveryError || reason instanceof Error ? reason.message : 'Não foi possível restaurar.' });
    }
  }

  const restoreItem = (item: TrashItem) =>
    run(async () => {
      await restoreFromTrash(session.db, item.entityType, item.id, session.context());
      return `"${item.title}" voltou para ${item.entityType === 'song' ? 'a biblioteca' : 'os repertórios'}.`;
    });
  const restoreEntry = (entry: HistoryEntry) =>
    run(async () => {
      await restoreRevision(session.db, entry.id, session.context());
      return `"${entry.title}" voltou à versão de ${dateFormat.format(new Date(entry.createdAt))}. A versão que estava em uso foi guardada no histórico.`;
    });

  return (
    <div className="flex flex-col gap-8" data-testid="trash">
      <header>
        <h1 className="text-[1.75rem] font-bold leading-tight md:text-3xl">Lixeira e histórico</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
          O que foi excluído e as versões anteriores guardadas neste dispositivo. Nada aqui depende de conexão.
          {session.team ? ' Restaurar é publicado para a equipe como qualquer alteração.' : ''}
        </p>
      </header>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? noticeClass('danger') : noticeClass('success', 'text-foreground')} data-testid="trash-message" data-kind={message.kind}>
          {message.text}
        </p>
      )}

      <section aria-labelledby="lixeira" className="flex flex-col gap-3">
        <h2 id="lixeira" className="text-lg font-bold">
          Lixeira
        </h2>
        {trash === null ? (
          <Loading>Carregando…</Loading>
        ) : trash.length === 0 ? (
          <EmptyState icon={<TrashIcon size={26} />} className="py-8" data-testid="trash-empty">
            Nada na lixeira.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Itens excluídos">
            {trash.map((item) => {
              const days = Math.floor((loadedAt - Date.parse(item.deletedAt)) / DAY_MS);
              return (
                <li key={`${item.entityType}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card" data-testid="trash-item" data-type={item.entityType} data-id={item.id}>
                  <div className="min-w-0">
                    <p className="font-semibold">{item.title}</p>
                    <p className="text-sm text-muted">
                      {TYPE_TEXT[item.entityType]} · excluído em {dateFormat.format(new Date(item.deletedAt))} ·{' '}
                      {item.entityType === 'song' ? `${item.parts} ${item.parts === 1 ? 'arranjo volta' : 'arranjos voltam'} junto` : `${item.parts} ${item.parts === 1 ? 'item' : 'itens'}`}
                    </p>
                    {session.team && days >= TRASH_RETENTION_DAYS && (
                      <p className="text-sm">Excluído há mais de {TRASH_RETENTION_DAYS} dias: o servidor da equipe pode recusar a restauração. Se recusar, o item aparece em &ldquo;Sincronização&rdquo;.</p>
                    )}
                    {item.conflict && <p className="text-sm text-danger">Em conflito com uma alteração da equipe: resolva em &ldquo;Sincronização&rdquo;.</p>}
                  </div>
                  {item.conflict ? (
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setLocalQuery({ view: 'sync' })}>
                      Abrir Sincronização
                    </button>
                  ) : (
                    <button type="button" className={buttonClass('primary', 'sm')} aria-label={`Restaurar ${item.title}`} onClick={() => void restoreItem(item)}>
                      Restaurar
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="historico" className="flex flex-col gap-3">
        <h2 id="historico" className="text-lg font-bold">
          Versões anteriores
        </h2>
        <p className="text-sm text-muted">
          Uma cópia é guardada antes de excluir, de regenerar os slides, de resolver um conflito e, ao editar, no máximo a cada dez minutos por documento.
        </p>
        {history === null ? (
          <Loading>Carregando…</Loading>
        ) : history.length === 0 ? (
          <EmptyState icon={<ClockIcon size={26} />} className="py-8" data-testid="history-empty">
            Nenhuma versão anterior guardada.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Versões anteriores">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card" data-testid="history-item" data-type={entry.entityType} data-reason={entry.reason} data-current={entry.current}>
                <div className="min-w-0">
                  <p className="font-semibold">
                    {entry.title}
                    {entry.songTitle ? <span className="font-normal text-muted"> · arranjo de {entry.songTitle}</span> : null}
                  </p>
                  <p className="text-sm text-muted">
                    {TYPE_TEXT[entry.entityType]} · {REASON_TEXT[entry.reason]} · {dateFormat.format(new Date(entry.createdAt))}
                  </p>
                </div>
                {entry.current ? (
                  <span className={pillClass('success')}>É a versão em uso</span>
                ) : (
                  <button type="button" className={buttonClass('secondary', 'sm')} aria-label={`Restaurar a versão de ${entry.title} de ${dateFormat.format(new Date(entry.createdAt))}`} onClick={() => void restoreEntry(entry)}>
                    Restaurar esta versão
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
