'use client';

import { adoptDeferredRemote, entityKey, type EntityState } from '@louvorvisual/sync';
import { useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { setLocalQuery } from '@/lib/localQuery';
import type { LocalSession } from '@/local/session';
import { syncEngine } from '@/sync/engine';
import { useSyncStatus } from '@/sync/hooks';

type Props = { session: LocalSession; songId: string; arrangementId: string; onBeforeReload: () => Promise<void>; onReload: () => void };

/**
 * Avisos de sincronização dentro do editor. Uma versão remota recebida com o
 * editor aberto nunca troca o texto na tela: fica aguardando aqui até o
 * operador decidir carregá-la. Conflito aberto leva à tela de comparação.
 */
export function EditorSyncNotice({ session, songId, arrangementId, onBeforeReload, onReload }: Props) {
  const engine = syncEngine(session);
  const status = useSyncStatus(engine);
  const [states, setStates] = useState<EntityState[]>([]);

  useEffect(() => {
    let current = true;
    const keys = [entityKey('song', songId), entityKey('arrangement', arrangementId)];
    void session.db.entityStates.bulkGet(keys).then((rows) => current && setStates(rows.filter((row): row is EntityState => row !== undefined)));
    return () => {
      current = false;
    };
  }, [session, songId, arrangementId, status]);

  const conflict = states.find((state) => state.conflict);
  const deferred = states.filter((state) => state.deferredRemote && !state.conflict);
  if (!conflict && deferred.length === 0) return null;
  const dirty = deferred.some((state) => state.dirty === 1);

  async function loadRemote() {
    await onBeforeReload();
    const deps = { storage: engine.storage, now: () => new Date().toISOString() };
    for (const state of deferred) await adoptDeferredRemote(deps, state.key);
    engine.announceLibraryChange();
    onReload();
  }

  return (
    <div role="status" data-testid="editor-sync-notice" data-kind={conflict ? 'conflict' : 'remote-newer'} data-remote-revision={deferred[0]?.deferredRemote?.revision ?? ''} className="flex flex-wrap items-center gap-3 rounded-lg border border-accent p-3 text-sm">
      {conflict ? (
        <>
          <span>Este conteúdo está em conflito com uma alteração da equipe. O que você digita aqui continua salvo neste dispositivo e não é enviado até você decidir.</span>
          <button type="button" className={buttonClass('primary', 'sm')} onClick={() => void onBeforeReload().then(() => setLocalQuery({ view: 'sync', conflito: conflict.conflict, song: null, arranjo: null }))}>
            Comparar e resolver
          </button>
        </>
      ) : (
        <>
          <span>
            A equipe publicou uma versão mais nova (revisão {deferred[0]?.deferredRemote?.revision}). O que está nesta tela não foi alterado.
            {dirty ? ' Como você já editou, as duas versões serão comparadas na próxima sincronização.' : ''}
          </span>
          {!dirty && (
            <button type="button" className={buttonClass('primary', 'sm')} data-action="load-remote" onClick={() => void loadRemote()}>
              Carregar a versão remota
            </button>
          )}
        </>
      )}
    </div>
  );
}
