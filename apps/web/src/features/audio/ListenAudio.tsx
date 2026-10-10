'use client';

import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@louvorvisual/domain';
import { buttonClass } from '@/components/ui/buttonStyles';
import { readAssetBlob, type LocalSession } from '@/local';
import { HttpSyncTransport } from '@/sync/api';

/** Ouvir online usa a URL da equipe; apenas Baixar grava os bytes no banco local. */
export function ListenAudio({ session, asset }: { session: LocalSession; asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const created = useRef<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => {
    if (created.current) URL.revokeObjectURL(created.current);
  }, []);

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const blob = await readAssetBlob(session.db, asset.workspaceId, asset.sha256);
      if (blob && blob.size === asset.byteSize) {
        created.current = URL.createObjectURL(blob);
        setUrl(created.current);
      } else {
        const team = session.team;
        if (!team || asset.remoteState !== 'ready' || asset.workspaceId !== team.workspaceId) throw new Error('O áudio ainda não está disponível online.');
        const transport = new HttpSyncTransport({ workspaceId: team.workspaceId, userId: team.userId });
        let identity = await transport.checkIdentity();
        if (identity === 'unauthenticated' && await transport.refreshSession()) identity = await transport.checkIdentity();
        if (identity !== 'ok') throw new Error(identity === 'unreachable' ? 'Conecte-se à internet para ouvir online ou baixe antes para ouvir offline.' : 'Entre na conta desta equipe para ouvir online.');
        setUrl('/api/v1/workspaces/' + team.workspaceId + '/assets/' + asset.id + '/content');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível abrir a faixa.');
    } finally { setBusy(false); }
  }

  return <div className="flex flex-col gap-1">
    {url ? <audio ref={player} controls preload="none" src={url} className="w-full" aria-label={'Ouvir ' + asset.filename} data-testid="audio-listen" onError={() => {
      player.current?.pause();
      setUrl(null);
      if (created.current) { URL.revokeObjectURL(created.current); created.current = null; }
      setError('Não foi possível reproduzir. Confira a conexão e tente de novo.');
    }} /> : <button type="button" className={buttonClass('secondary', 'sm', 'self-start')} disabled={busy} onClick={() => void open()} aria-label={'Ouvir ' + asset.filename}>
      {busy ? 'Abrindo…' : '▶ Ouvir'}
    </button>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
