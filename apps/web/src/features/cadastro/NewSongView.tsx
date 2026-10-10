'use client';

import {
  createArrangement,
  createSong,
  DEFAULT_THEME_PRESET_ID,
  findSimilarSongs,
  generateOccurrences,
  MAX_LYRICS_CHARS,
  maxLinesForStyle,
  parseLyrics,
  songInputIssues,
  themePreset,
  type AudioBinding,
  type AudioKind,
} from '@louvorvisual/domain';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { SparkIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { cardClass, Loading, noticeClass, PageHeader } from '@/components/ui/PageHeader';
import { Textarea } from '@/components/ui/Textarea';
import { setLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { importAudioFile, listSongIndex, saveDocuments, useLocalSession, type LocalSession, type SongIndexRow } from '@/local';
import { estimateFreeSpace, probeAudio } from '../audio/htmlTransport';
import { lyricsFromLrclib, searchLrclib, type LrclibTrack } from '../editor/lrclib';

import { YoutubeImport } from './YoutubeImport';

const SPLIT = { maxLines: maxLinesForStyle(themePreset(DEFAULT_THEME_PRESET_ID).style) };

/** Prévia determinística: os IDs daqui são descartados; os definitivos nascem ao salvar. */
function preview(rawLyrics: string) {
  let next = 0;
  const newId = () => `previa-${++next}`;
  const parsed = parseLyrics(rawLyrics, newId);
  return { parsed, slides: generateOccurrences(parsed, newId, SPLIT).length };
}

export function NewSongView() {
  const local = useLocalSession();
  if (local.status === 'loading') return <Loading>Abrindo os dados deste dispositivo…</Loading>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  return <NewSongForm session={local.session} />;
}

function NewSongForm({ session }: { session: LocalSession }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [rawLyrics, setRawLyrics] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<SongIndexRow[]>([]);
  const [lyricMatches, setLyricMatches] = useState<LrclibTrack[] | null>(null);
  const [lookingForLyrics, setLookingForLyrics] = useState(false);
  const [lyricsLookupError, setLyricsLookupError] = useState<string | null>(null);
  const [audioFiles, setAudioFiles] = useState<Partial<Record<AudioKind, File>>>({});

  useEffect(() => {
    void listSongIndex(session.db, session.profile.workspaceId).then(setExisting);
  }, [session]);

  // A busca espera a pessoa terminar de digitar e cancela a anterior. O título
  // e artista seguem sendo só pistas: a LRCLIB devolve candidatos parecidos.
  useEffect(() => {
    if (title.trim().length < 3) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setLookingForLyrics(true);
      setLyricsLookupError(null);
      void searchLrclib(title, artist, controller.signal)
        .then((tracks) => {
          if (!controller.signal.aborted) setLyricMatches(tracks.filter((track) => lyricsFromLrclib(track)).slice(0, 5));
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setLyricMatches(null);
          setLyricsLookupError(reason instanceof Error ? reason.message : 'Não foi possível buscar sugestões de letra.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLookingForLyrics(false);
        });
    }, 550);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [title, artist]);

  const issues = songInputIssues({ title, rawLyrics });
  const suggestion = useMemo(() => preview(rawLyrics), [rawLyrics]);
  const similar = useMemo(() => findSimilarSongs(existing, title), [existing, title]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const context = session.context();
      const { song, parsed } = createSong({ title, artist, rawLyrics }, context);
      const arrangement = createArrangement(song, parsed, context, {
        themeRef: { kind: 'builtin', presetId: DEFAULT_THEME_PRESET_ID },
        ...SPLIT,
      });
      const imported = await Promise.all(
        (['original', 'playback'] as const).flatMap((kind) => {
          const file = audioFiles[kind];
          if (!file) return [];
          return [
            importAudioFile(session.db, {
              file,
              filename: file.name,
              kind,
              profileId: session.profile.profileId,
              workspaceId: session.profile.workspaceId,
              now: () => new Date().toISOString(),
              newId: context.newId,
              probe: probeAudio,
              freeSpace: estimateFreeSpace,
            }).then(({ asset }) => ({ kind, asset })),
          ];
        }),
      );
      const audioBindings: AudioBinding[] = imported.map(({ kind, asset }) => ({
        id: context.newId(),
        assetId: asset.id,
        kind,
        policy: 'independent',
        volume: 1,
        offsetMs: 0,
        cuesVersion: 0,
        cues: [],
      }));
      const playback = audioBindings.find((binding) => binding.kind === 'playback');
      const original = audioBindings.find((binding) => binding.kind === 'original');
      const arrangementWithAudio = {
        ...arrangement,
        audioBindings,
        selectedAudioBindingId: playback?.id ?? original?.id ?? null,
      };
      await saveDocuments(session.db, [
        { entityType: 'song', document: song },
        { entityType: 'arrangement', document: arrangementWithAudio },
      ]);
      setLocalQuery({ view: 'editor', song: song.id, arranjo: arrangement.id });
    } catch (reason) {
      // O formulário continua preenchido: nada do que foi digitado se perde.
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
      setSaving(false);
    }
  }

  const sections = suggestion.parsed.sections.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Novo louvor"
        description="Importe pela URL do YouTube ou preencha o título e a letra manualmente."
      />

      <YoutubeImport session={session} />

      <form onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className={cn(cardClass, 'flex flex-col gap-5 p-4 sm:p-6')}>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="titulo" required>
                Título
              </Label>
              <Input
                id="titulo"
                // A tela é aberta para digitar o título: o foco já começa nele.
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                autoComplete="off"
                error={submitted && issues.includes('title-required') ? 'Informe o título.' : undefined}
              />
            </div>
            <div>
              <Label htmlFor="artista">Artista</Label>
              <Input id="artista" value={artist} onChange={(event) => setArtist(event.target.value)} autoComplete="off" />
            </div>
          </div>
          {similar.length > 0 && (
            <p className={noticeClass('accent', 'text-foreground')} data-testid="similar-songs">
              Este louvor parece já existir:{' '}
              {similar.map((row, index) => (
                <span key={row.id}>
                  {index > 0 && ', '}
                  <a className="font-semibold text-accent underline underline-offset-4" href={`/app?view=editor&song=${row.id}`}>
                    abrir &ldquo;{row.title}&rdquo;
                  </a>
                </span>
              ))}
              . Você também pode salvar este como um novo.
            </p>
          )}

          <div>
            <Label htmlFor="letra">Letra</Label>
            {title.trim().length >= 3 && (lookingForLyrics || lyricMatches || lyricsLookupError) && (
              <div className="mb-3 flex flex-col gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm" data-testid="lyrics-suggestions">
                <div>
                  <p className="font-semibold">Sugestões automáticas de letra</p>
                  <p className="text-xs text-muted">Encontramos músicas parecidas com o título e artista informados; os nomes não precisam ser idênticos.</p>
                </div>
                {lookingForLyrics && <p role="status" className="text-muted">Buscando letra…</p>}
                {lyricsLookupError && <p role="alert" className="text-danger">{lyricsLookupError}</p>}
                {lyricMatches?.length === 0 && <p className="text-muted">Nenhuma letra sugerida. Você pode colar ou escrever a letra abaixo.</p>}
                {lyricMatches && lyricMatches.length > 0 && (
                  <ul className="flex flex-col gap-2" aria-label="Sugestões de letra">
                    {lyricMatches.map((track) => (
                      <li key={track.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-raised p-2">
                        <span><strong>{track.trackName}</strong> · {track.artistName}{track.albumName ? ` · ${track.albumName}` : ''}</span>
                        <button
                          type="button"
                          className={buttonClass('secondary', 'sm')}
                          onClick={() => {
                            setTitle(track.trackName);
                            setArtist(track.artistName);
                            setRawLyrics(lyricsFromLrclib(track) ?? '');
                          }}
                        >
                          Usar louvor e letra
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Textarea
              id="letra"
              value={rawLyrics}
              onChange={(event) => setRawLyrics(event.target.value)}
              rows={14}
              spellCheck={false}
              aria-describedby="letra-ajuda"
              placeholder={'[Estrofe 1]\n…\n\n[Refrão]\n…'}
              className="min-h-64 font-mono text-[13px] leading-relaxed"
              error={issues.includes('lyrics-too-long') ? `A letra passa de ${MAX_LYRICS_CHARS.toLocaleString('pt-BR')} caracteres.` : undefined}
            />
            <p id="letra-ajuda" className="mt-2 text-xs leading-relaxed text-muted">
              Separe as partes com uma linha vazia. Marcadores em linha própria ajudam: [Estrofe 1], [Refrão], [Ponte],
              [Introdução], [Instrumental]. &ldquo;[Refrão 2x]&rdquo; repete a parte.
            </p>
          </div>

          <fieldset className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold">Áudio opcional</legend>
            <AudioFileInput kind="original" file={audioFiles.original} onChange={(file) => setAudioFiles((previous) => ({ ...previous, original: file }))} />
            <AudioFileInput kind="playback" file={audioFiles.playback} onChange={(file) => setAudioFiles((previous) => ({ ...previous, playback: file }))} />
            <p className="sm:col-span-2 text-xs text-muted">Se houver playback, ele será a faixa padrão da apresentação. As faixas são independentes dos slides.</p>
          </fieldset>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-6">
          <section aria-labelledby="sugestao" className={cn(cardClass, 'flex flex-col gap-3 p-5 text-sm')}>
            <h2 id="sugestao" className="flex items-center gap-2 text-base font-bold">
              <SparkIcon className="text-accent" />
              Sugestão
            </h2>
            <div aria-hidden="true" className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-surface-overlay p-3">
                <p className="text-2xl font-bold tabular-nums">{sections}</p>
                <p className="text-xs text-muted">{sections === 1 ? 'seção' : 'seções'}</p>
              </div>
              <div className="rounded-xl bg-surface-overlay p-3">
                <p className="text-2xl font-bold tabular-nums">{suggestion.slides}</p>
                <p className="text-xs text-muted">{suggestion.slides === 1 ? 'slide' : 'slides'}</p>
              </div>
            </div>
            <p role="status" className="text-muted" data-testid="suggestion-summary" data-sections={sections} data-slides={suggestion.slides}>
              {sections === 0
                ? 'Sem letra: o louvor será criado sem slides.'
                : `${sections} ${sections === 1 ? 'seção' : 'seções'} e ${suggestion.slides} ${suggestion.slides === 1 ? 'slide' : 'slides'}.`}
            </p>
            {suggestion.parsed.warnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-muted" aria-label="Pontos para revisar">
                {suggestion.parsed.warnings.map((warning, index) => (
                  <li key={index}>
                    Linha {warning.line}: {warning.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error && (
            <p role="alert" className={noticeClass('danger')}>
              {error} A letra continua neste formulário; copie-a se for fechar a página.
            </p>
          )}

          <div className="flex flex-wrap gap-3 lg:flex-col">
            <button type="submit" className={buttonClass('primary', 'lg', 'max-lg:flex-1')} disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar e revisar slides'}
            </button>
            <button type="button" className={buttonClass('ghost', 'lg')} onClick={() => setLocalQuery({ view: 'biblioteca' })}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
      </form>
    </div>
  );
}

function AudioFileInput({ kind, file, onChange }: { kind: AudioKind; file: File | undefined; onChange: (file: File | undefined) => void }) {
  const label = kind === 'playback' ? 'Playback' : 'Música original';
  const id = `audio-${kind}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="file" accept="audio/*" onChange={(event) => onChange(event.target.files?.[0])} />
      <p className="mt-1 truncate text-xs text-muted">{file ? file.name : 'Nenhum arquivo escolhido'}</p>
    </div>
  );
}
