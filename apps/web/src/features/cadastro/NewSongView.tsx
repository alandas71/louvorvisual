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
} from '@louvorvisual/domain';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import { setLocalQuery } from '@/lib/localQuery';
import { listSongIndex, saveDocuments, useLocalSession, type LocalSession, type SongIndexRow } from '@/local';

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
  if (local.status === 'loading') return <p role="status">Abrindo os dados deste dispositivo…</p>;
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

  useEffect(() => {
    void listSongIndex(session.db, session.profile.workspaceId).then(setExisting);
  }, [session]);

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
      await saveDocuments(session.db, [
        { entityType: 'song', document: song },
        { entityType: 'arrangement', document: arrangement },
      ]);
      setLocalQuery({ view: 'editor', song: song.id, arranjo: arrangement.id });
    } catch (reason) {
      // O formulário continua preenchido: nada do que foi digitado se perde.
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5" noValidate>
      <header>
        <h1 className="text-2xl font-bold">Novo louvor</h1>
        <p className="mt-1 text-muted">
          Cole a letra como ela é. O aplicativo guarda o texto original e sugere seções e slides, que você revisa em seguida.
        </p>
      </header>

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
        {similar.length > 0 && (
          <p className="mt-2 text-sm" data-testid="similar-songs">
            Este louvor parece já existir:{' '}
            {similar.map((row, index) => (
              <span key={row.id}>
                {index > 0 && ', '}
                <a className="text-accent underline underline-offset-4" href={`/app?view=editor&song=${row.id}`}>
                  abrir &ldquo;{row.title}&rdquo;
                </a>
              </span>
            ))}
            . Você também pode salvar este como um novo.
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="artista">Artista</Label>
        <Input id="artista" value={artist} onChange={(event) => setArtist(event.target.value)} autoComplete="off" />
      </div>

      <div>
        <Label htmlFor="letra">Letra</Label>
        <Textarea
          id="letra"
          value={rawLyrics}
          onChange={(event) => setRawLyrics(event.target.value)}
          rows={14}
          spellCheck={false}
          aria-describedby="letra-ajuda"
          placeholder={'[Estrofe 1]\n…\n\n[Refrão]\n…'}
          error={issues.includes('lyrics-too-long') ? `A letra passa de ${MAX_LYRICS_CHARS.toLocaleString('pt-BR')} caracteres.` : undefined}
        />
        <p id="letra-ajuda" className="mt-1 text-xs text-muted">
          Separe as partes com uma linha vazia. Marcadores em linha própria ajudam: [Estrofe 1], [Refrão], [Ponte],
          [Introdução], [Instrumental]. &ldquo;[Refrão 2x]&rdquo; repete a parte.
        </p>
      </div>

      <section aria-labelledby="sugestao" className="rounded-xl border border-border bg-surface-raised p-4 text-sm">
        <h2 id="sugestao" className="font-semibold">
          Sugestão
        </h2>
        <p role="status" data-testid="suggestion-summary" data-sections={suggestion.parsed.sections.length} data-slides={suggestion.slides}>
          {suggestion.parsed.sections.length === 0
            ? 'Sem letra: o louvor será criado sem slides.'
            : `${suggestion.parsed.sections.length} ${suggestion.parsed.sections.length === 1 ? 'seção' : 'seções'} e ${suggestion.slides} ${suggestion.slides === 1 ? 'slide' : 'slides'}.`}
        </p>
        {suggestion.parsed.warnings.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-muted" aria-label="Pontos para revisar">
            {suggestion.parsed.warnings.map((warning, index) => (
              <li key={index}>
                Linha {warning.line}: {warning.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error} A letra continua neste formulário; copie-a se for fechar a página.
        </p>
      )}

      <div className="flex gap-3">
        <button type="submit" className={buttonClass('primary')} disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar e revisar slides'}
        </button>
        <button type="button" className={buttonClass()} onClick={() => setLocalQuery({ view: 'biblioteca' })}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
