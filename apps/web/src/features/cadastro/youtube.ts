import { createSong, createArrangement, DEFAULT_THEME_PRESET_ID, deriveCues, MAX_ASSET_BYTES, normalizeYoutubeUrl, parseSyncedLyrics, timedYoutubeSlides } from '@louvorvisual/domain';
import { liveQuery } from 'dexie';
import { entityKey } from '@louvorvisual/sync';
import { importAudioFile, saveDocuments, type LocalSession } from '@/local';
import { syncEngine } from '@/sync/engine';
import { probeAudio, estimateFreeSpace } from '../audio/htmlTransport';

export type ImportedYoutubeSong = { songId: string; arrangementId: string; assetId: string; title: string };
type Metadata = { title: string; artist: string; sourceUrl: string; rawLyrics: string; syncedLyrics: string; lyricsId: number; durationMs: number };

export async function createYoutubeSong(session: LocalSession, value: string, onStatus: (message: string) => void): Promise<ImportedYoutubeSong> {
  const url = normalizeYoutubeUrl(value);
  if (!url) throw new Error('Informe a URL de um vídeo do YouTube.');
  if (!session.team || !['editor', 'admin'].includes(session.team.role)) throw new Error('Entre em uma equipe com permissão de edição para importar e publicar.');
  onStatus('Identificando o vídeo, escolhendo a letra pelo tempo e convertendo para MP3…');
  let response: Response;
  try {
    response = await fetch('/api/v1/workspaces/' + session.team.workspaceId + '/imports/youtube', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(11 * 60_000),
    });
  } catch {
    throw new Error('Não foi possível alcançar o servidor de importação. Verifique a conexão e tente novamente.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (body?.error?.message) throw new Error(body.error.message);
    if (response.status === 404 || response.status === 502 || response.status === 503) {
      throw new Error('O servidor de importação não está conectado ao aplicativo. Configure BACKEND_URL no serviço web e reinicie os serviços.');
    }
    throw new Error(`O servidor de importação respondeu com erro ${response.status}. Tente novamente.`);
  }
  const form = await response.formData();
  const metadata = JSON.parse(String(form.get('metadata'))) as Metadata;
  const audio = form.get('audio');
  if (!(audio instanceof Blob) || !audio.size || audio.size > MAX_ASSET_BYTES || typeof metadata.title !== 'string' || typeof metadata.artist !== 'string' || typeof metadata.syncedLyrics !== 'string') throw new Error('A importação retornou dados inválidos.');
  const context = session.context();
  const occurrences = timedYoutubeSlides(parseSyncedLyrics(metadata.syncedLyrics), metadata.durationMs, context.newId);
  if (!occurrences) throw new Error('Os tempos da letra não são compatíveis com a gravação.');
  onStatus('Conferindo o áudio e salvando o louvor com a letra sincronizada…');
  const { asset } = await importAudioFile(session.db, { file: audio, filename: metadata.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 180) + '.mp3',
    kind: 'original', profileId: session.profile.profileId, workspaceId: session.profile.workspaceId, newId: context.newId,
    now: () => new Date().toISOString(), probe: probeAudio, freeSpace: estimateFreeSpace });
  if (asset.durationMs === null || Math.abs(asset.durationMs - metadata.durationMs) > 1000) throw new Error('A duração do áudio recebido diverge dos tempos da letra.');
  const { song, parsed } = createSong({ title: metadata.title, artist: metadata.artist, rawLyrics: metadata.rawLyrics }, context);
  song.notes = 'Importado de ' + metadata.sourceUrl + '\nLetra sincronizada: LRCLIB #' + metadata.lyricsId;
  const arrangement = createArrangement(song, parsed, context, { themeRef: { kind: 'builtin', presetId: DEFAULT_THEME_PRESET_ID } });
  const bindingId = context.newId();
  arrangement.occurrences = occurrences;
  arrangement.defaultMode = 'automatic';
  arrangement.audioBindings = [{ id: bindingId, assetId: asset.id, kind: 'original', policy: 'linked', volume: 1, offsetMs: 0, cuesVersion: 1, cues: deriveCues(occurrences, 0)! }];
  arrangement.selectedAudioBindingId = bindingId;
  await saveDocuments(session.db, [{ entityType: 'song', document: song }, { entityType: 'arrangement', document: arrangement }]);
  syncEngine(session).announceLibraryChange();
  return { songId: song.id, arrangementId: arrangement.id, assetId: asset.id, title: song.title };
}

/** Sucesso só depois da confirmação remota dos documentos e dos bytes do áudio. */
export function publishYoutubeSong(session: LocalSession, song: ImportedYoutubeSong): Promise<void> {
  const engine = syncEngine(session);
  engine.syncNow();
  return new Promise((resolve, reject) => {
    const keys = [entityKey('song', song.songId), entityKey('arrangement', song.arrangementId), entityKey('asset', song.assetId)];
    const finish = (error?: Error) => { clearTimeout(timeout); subscription.unsubscribe(); if (error) reject(error); else resolve(); };
    const timeout = setTimeout(() => finish(new Error('O louvor foi salvo neste dispositivo, mas a publicação ainda não foi confirmada. Tente publicar novamente.')), 90_000);
    const subscription = liveQuery(async () => ({ states: await session.db.entityStates.bulkGet(keys), asset: await session.db.assets.get(song.assetId), meta: await session.db.syncMeta.get('sync') })).subscribe({
      next: ({ states, asset, meta }) => {
        if (meta?.suspended || states.some(state => state?.blocked || state?.conflict)) { finish(new Error('O louvor está salvo neste dispositivo. A publicação foi bloqueada; confira a tela de sincronização.')); return; }
        if (states.every(state => state && state.dirty === 0 && state.serverRevision !== null) && asset?.remoteState === 'ready') finish();
      },
      error: (reason: unknown) => finish(reason instanceof Error ? reason : new Error('Não foi possível confirmar a publicação.')),
    });
  });
}
