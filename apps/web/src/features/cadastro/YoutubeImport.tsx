'use client';

import { useRef, useState } from 'react';
import { normalizeYoutubeUrl } from '@louvorvisual/domain';
import { buttonClass } from '@/components/ui/buttonStyles';
import { cardClass, noticeClass } from '@/components/ui/PageHeader';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { setLocalQuery } from '@/lib/localQuery';
import type { LocalSession } from '@/local';
import { createYoutubeSong, publishYoutubeSong, type ImportedYoutubeSong } from './youtube';

export function YoutubeImport({ session }: { session: LocalSession }) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ImportedYoutubeSong | null>(null);
  const [published, setPublished] = useState(false);
  const busy = useRef(false);
  const allowed = session.team && ['editor', 'admin'].includes(session.team.role);

  async function importAndPublish() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const song = saved ?? await createYoutubeSong(session, url, setStatus);
      setSaved(song);
      setStatus('Publicando o áudio, a letra e os slides na biblioteca da equipe…');
      await publishYoutubeSong(session, song);
      setPublished(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível importar o louvor.');
    } finally { busy.current = false; setStatus(null); }
  }

  return <section aria-labelledby="youtube-import-title" className={cardClass + ' flex flex-col gap-4 p-4 sm:p-6'} data-testid="youtube-import">
    <div><h2 id="youtube-import-title" className="text-lg font-bold">Importar do YouTube</h2>
      <p className="text-sm text-muted">Cole a URL. O aplicativo baixa e converte o áudio em MP3, escolhe a letra sincronizada mais próxima da duração e publica o louvor com os slides.</p></div>
    {!allowed && <p className="text-sm text-muted">Entre na sua conta e selecione uma equipe com permissão de edição para importar e publicar.</p>}
    <div><Label htmlFor="youtube-url">URL do YouTube</Label>
      <Input id="youtube-url" type="url" value={url} onChange={event => { setUrl(event.target.value); setError(null); }} placeholder="https://www.youtube.com/watch?v=…" disabled={Boolean(status) || Boolean(saved)} autoComplete="off" /></div>
    {status && <p role="status" className="text-sm text-muted">{status}</p>}
    {error && <p role="alert" className={noticeClass('danger')}>{error}</p>}
    {published ? <div className="flex flex-wrap items-center gap-3"><p role="status" className="text-success">✓ {saved?.title} publicado com áudio e letra sincronizada.</p>
      <button type="button" className={buttonClass('primary', 'md')} onClick={() => setLocalQuery({ view: 'editor', song: saved!.songId, arranjo: saved!.arrangementId })}>Abrir louvor</button></div> :
      <div className="flex flex-wrap gap-3"><button type="button" className={buttonClass('primary', 'md')} disabled={!allowed || Boolean(status) || (!saved && !normalizeYoutubeUrl(url))} onClick={() => void importAndPublish()}>
        {status ? 'Processando…' : saved ? 'Tentar publicar novamente' : 'Importar e publicar'}</button>
        {saved && !status && <button type="button" className={buttonClass('secondary', 'md')} onClick={() => setLocalQuery({ view: 'editor', song: saved.songId, arranjo: saved.arrangementId })}>Abrir cópia salva</button>}</div>}
  </section>;
}
