'use client';

import { useEffect, useState } from 'react';
import { audioUsage, countPending, listSongIndex, LOCAL_DB_VERSION, removeUnusedAudio, useLocalSession, type AudioUsage } from '@/local';

type StorageInfo = { persisted: boolean | null; usage: number | null; quota: number | null };

/** Abaixo disto a tela avisa: é pouco para uma faixa de áudio (até 100 MiB) com folga. */
const LOW_SPACE_BYTES = 200 * 1024 * 1024;

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

async function readStorage(): Promise<StorageInfo> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage) return { persisted: null, usage: null, quota: null };
  const estimate = await storage.estimate?.().catch(() => undefined);
  return { persisted: (await storage.persisted?.().catch(() => null)) ?? null, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
}

/** Situação dos dados gravados neste dispositivo e do pedido de armazenamento persistente. */
export function LocalDataSection({ buttonClassName }: { buttonClassName: string }) {
  const local = useLocalSession();
  const [counts, setCounts] = useState<{ songs: number; pending: number } | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [denied, setDenied] = useState(false);
  const [audio, setAudio] = useState<AudioUsage | null>(null);
  const session = local.status === 'ready' ? local.session : null;

  useEffect(() => {
    void readStorage().then(setStorage);
  }, []);

  useEffect(() => {
    if (!session) return;
    let current = true;
    void Promise.all([listSongIndex(session.db, session.profile.workspaceId), countPending(session.db, session.profile.workspaceId)]).then(
      ([songs, pending]) => current && setCounts({ songs: songs.length, pending }),
    );
    void audioUsage(session.db, session.profile.workspaceId).then((usage) => current && setAudio(usage));
    return () => {
      current = false;
    };
  }, [session]);

  async function requestPersistence() {
    const granted = (await navigator.storage?.persist?.().catch(() => false)) ?? false;
    setDenied(!granted);
    setStorage(await readStorage());
  }

  return (
    <section aria-labelledby="dados-locais" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-5">
      <h2 id="dados-locais" className="text-lg font-semibold">
        Dados neste dispositivo
      </h2>
      {local.status === 'error' ? (
        <p role="alert" className="text-danger">
          {local.message}
        </p>
      ) : (
        <p role="status" data-testid="local-data" data-songs={counts?.songs} data-pending={counts?.pending}>
          {counts === null
            ? 'Abrindo o banco local…'
            : `${counts.songs} ${counts.songs === 1 ? 'louvor gravado' : 'louvores gravados'}. ${counts.pending} ${counts.pending === 1 ? 'alteração ainda não foi confirmada' : 'alterações ainda não foram confirmadas'} por um servidor${session?.team ? '; veja o andamento em "Sincronização"' : ' (o perfil pessoal não é enviado)'}.`}
        </p>
      )}
      <p className="text-sm text-muted">Banco local na versão {LOCAL_DB_VERSION}.</p>
      {audio && (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="audio-usage" data-files={audio.files} data-bytes={audio.bytes} data-unused-files={audio.unusedFiles}>
          <p>
            {audio.files === 0
              ? 'Nenhum arquivo de áudio guardado.'
              : `${audio.files} ${audio.files === 1 ? 'arquivo de áudio guardado' : 'arquivos de áudio guardados'}, ${megabytes(audio.bytes)}.`}
            {audio.unusedFiles > 0 && ` ${audio.unusedFiles} sem uso por nenhum arranjo, sessão ou repertório preparado (${megabytes(audio.unusedBytes)}).`}
          </p>
          {audio.unusedFiles > 0 && session && (
            <button type="button" className={buttonClassName} onClick={() => void removeUnusedAudio(session.db, session.profile.workspaceId).then(() => audioUsage(session.db, session.profile.workspaceId)).then(setAudio)}>
              Remover áudios sem uso
            </button>
          )}
        </div>
      )}

      {storage && (
        <>
          <p data-testid="storage-persisted" data-persisted={String(storage.persisted)} className="text-sm">
            {storage.persisted === true && 'Armazenamento persistente concedido: o navegador não apaga estes dados por falta de espaço.'}
            {storage.persisted === false && 'Armazenamento não persistente: o navegador pode apagar estes dados se o disco ficar cheio.'}
            {storage.persisted === null && 'Este navegador não informa se os dados são persistentes.'}
          </p>
          {storage.usage !== null && storage.quota !== null && (
            <p className="text-sm text-muted">
              Uso aproximado: {megabytes(storage.usage)} de {megabytes(storage.quota)} disponíveis para o aplicativo.
            </p>
          )}
          {storage.usage !== null && storage.quota !== null && storage.quota - storage.usage < LOW_SPACE_BYTES && (
            <p role="alert" className="text-sm font-semibold text-danger" data-testid="storage-low">
              Pouco espaço: restam {megabytes(Math.max(0, storage.quota - storage.usage))}. Uma gravação que não couber é recusada inteira e o que já existe continua intacto. Para liberar
              espaço, remova os áudios sem uso acima ou libere espaço no disco; antes, exporte um pacote de segurança dos repertórios em &ldquo;Repertórios&rdquo;
              {session?.team ? ' e as pendências em “Sincronização”' : ''}.
            </p>
          )}
          {storage.persisted === false && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={buttonClassName} onClick={() => void requestPersistence()}>
                Pedir armazenamento persistente
              </button>
              {denied && <p className="text-sm">O navegador não concedeu. Instalar o aplicativo ou usá-lo com frequência costuma liberar.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
