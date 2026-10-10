'use client';

import type { Asset } from '@louvorvisual/domain';
import { ListenAudio } from './ListenAudio';
import { useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { CheckIcon, OfflineIcon } from '@/components/ui/icons';
import { assetPresent, type LocalSession } from '@/local';
import { syncEngine } from '@/sync/engine';
import { useLibraryVersion } from '@/sync/hooks';

export function DownloadAudioButton({ session, songId, assetId, title }: { session: LocalSession; songId?: string; assetId?: string; title: string }) {
  const [tracks, setTracks] = useState<Asset[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [hasAudio, setHasAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const version = useLibraryVersion();
  useEffect(() => {
    let current = true;
    void (async () => {
      const ids = assetId ? [assetId] : [...new Set((await session.db.arrangements.where('songId').equals(songId!).toArray()).filter(a => a.deletedAt === null).flatMap(a => a.audioBindings.map(b => b.assetId)))];
      const assets = (await session.db.assets.bulkGet(ids)).filter(a => a && a.deletedAt === null && a.workspaceId === session.profile.workspaceId);
      const absent: string[] = [];
      for (const asset of assets) if (asset && asset.remoteState === 'ready' && !(await assetPresent(session.db, asset))) absent.push(asset.id);
      const present = assets.length > 0 && (await Promise.all(assets.map(a => assetPresent(session.db, a!)))).every(Boolean);
      if (current) { setMissing(absent); setHasAudio(present); setTracks(assets.filter((a): a is Asset => a !== undefined)); }
    })().catch(() => { if (current) setError('Não foi possível conferir os áudios.'); });
    return () => { current = false; };
  }, [session, songId, assetId, version]);

  async function download() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await syncEngine(session).downloadAssets(missing);
      setMissing([]);
      setHasAudio(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível baixar. Tente de novo.');
    } finally { active.current = false; setBusy(false); }
  }

  if (!session.team) return null;
  return <div className="flex flex-col gap-1">
    {songId && tracks.filter(a => a.remoteState === 'ready').map(a => <div key={a.id}><span className="text-xs text-muted">{a.audioKind === 'original' ? 'Original' : 'Playback'}</span><ListenAudio session={session} asset={a} /></div>)}
    {missing.length > 0 ? <button type="button" className={buttonClass('secondary', 'sm')} disabled={busy} aria-label={(busy ? 'Baixando ' : 'Baixar ') + title} onClick={() => void download()}>
      <OfflineIcon size={15} />{busy ? 'Baixando…' : 'Baixar para offline'}
    </button> : hasAudio ? <span className="flex items-center gap-1 text-xs text-muted"><CheckIcon size={15} />Áudio neste dispositivo</span> : null}
    {error && <p role="alert" className="max-w-xs text-xs text-danger">{error}</p>}
  </div>;
}
