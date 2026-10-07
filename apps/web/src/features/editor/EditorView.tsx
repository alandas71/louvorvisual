'use client';

import {
  applyThemeToArrangement,
  ASPECT_RATIOS,
  BUNDLED_FONTS,
  equivalentOccurrenceIds,
  maxLinesForStyle,
  parseList,
  parseTimerSeconds,
  SECTION_KINDS,
  THEME_PRESETS,
  type AspectRatio,
  type SectionKind,
  type Theme,
  type ThemeOverrides,
  type Uuid,
} from '@louvorvisual/domain';
import { useEffect, useMemo, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { listThemes, LocalSaveError, useLocalSession, type LocalSession } from '@/local';
import { AudioSection } from './AudioSection';
import { EditorSyncNotice } from './EditorSyncNotice';
import { EDIT_ERROR_TEXT, EDIT_REVIEW_TEXT, SECTION_KIND_LABEL } from './messages';
import { OccurrenceCard } from './OccurrenceCard';
import type { SaveStatus } from './saver';
import { useEditor, type EditorActions } from './useEditor';
import { resolveArrangementVisual } from './visual';

export function EditorView() {
  const query = useLocalQuery();
  const local = useLocalSession();
  // Carregar a versão remota recria o editor a partir do que está gravado.
  const [reloads, setReloads] = useState(0);
  const songId = query.get('song');
  if (!songId) return <Missing />;
  if (local.status === 'loading') return <p role="status">Abrindo o louvor…</p>;
  if (local.status === 'error') return <p role="alert">{local.message}</p>;
  // A chave recria o editor ao trocar de louvor ou de arranjo.
  return <Editor key={`${songId}:${query.get('arranjo') ?? ''}:${reloads}`} session={local.session} songId={songId} arrangementId={query.get('arranjo')} onReload={() => setReloads((count) => count + 1)} />;
}

function Missing() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Louvor não encontrado</h1>
      <p className="text-muted">Ele não existe neste dispositivo ou foi excluído.</p>
      <BackToLibrary />
    </div>
  );
}

function BackToLibrary({ onBefore }: { onBefore?: () => Promise<void> }) {
  return (
    <button
      type="button"
      className={buttonClass('secondary', 'sm', 'self-start')}
      onClick={() => void (onBefore?.() ?? Promise.resolve()).then(() => setLocalQuery({ view: 'biblioteca', song: null, arranjo: null }))}
    >
      ← Biblioteca
    </button>
  );
}

function SaveIndicator({ status, onRetry, onCopy }: { status: SaveStatus; onRetry: () => void; onCopy: () => void }) {
  if (status.state === 'error') {
    const message = status.error instanceof LocalSaveError ? status.error.message : 'Não foi possível gravar neste dispositivo.';
    return (
      <div role="alert" data-testid="save-status" data-state="error" className="flex flex-wrap items-center gap-2 text-sm text-danger">
        <span>⚠ Não salvo. {message} O conteúdo continua aberto nesta tela.</span>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={onRetry}>
          Tentar novamente
        </button>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={onCopy}>
          Copiar letra e slides
        </button>
      </div>
    );
  }
  return (
    <p role="status" data-testid="save-status" data-state={status.state} className="text-sm text-muted">
      {status.state === 'saving' ? 'Salvando…' : '✓ Salvo neste dispositivo'}
    </p>
  );
}

function Editor({ session, songId, arrangementId, onReload }: { session: LocalSession; songId: Uuid; arrangementId: Uuid | null; onReload: () => void }) {
  const { state, saveStatus, notice, actions } = useEditor(session, songId, arrangementId);
  const [selection, setSelection] = useState<Uuid[]>([]);

  // Ctrl+Z / Ctrl+Shift+Z fora de campos de texto, onde o navegador já desfaz a digitação.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      const element = event.target as HTMLElement | null;
      if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)) return;
      event.preventDefault();
      if (event.shiftKey) actions.redo();
      else actions.undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (state.status === 'loading') return <p role="status">Abrindo o louvor…</p>;
  if (state.status === 'missing') return <Missing />;
  const { song, arrangement } = state;

  const occurrences = [...arrangement.occurrences].sort((a, b) => a.order - b.order);
  const visual = resolveArrangementVisual(arrangement);
  const maxLines = maxLinesForStyle(visual.style);
  const selected = selection.filter((id) => occurrences.some((occurrence) => occurrence.id === id));

  function copyContent() {
    const slides = occurrences.map((occurrence, index) => `--- ${index + 1} · ${occurrence.label}\n${occurrence.text}`).join('\n\n');
    void navigator.clipboard?.writeText(`${song.title}\n\n${song.rawLyrics}\n\n=== Slides ===\n${slides}`);
  }

  return (
    <div className="flex flex-col gap-8" data-testid="editor" data-song-id={song.id} data-arrangement-id={arrangement.id}>
      <header className="flex flex-col gap-2">
        <BackToLibrary onBefore={actions.flush} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{song.title}</h1>
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={occurrences.length === 0}
            onClick={() => void actions.flush().then(() => setLocalQuery({ view: 'apresentar', song: song.id, arranjo: arrangement.id }))}
          >
            ▶ Apresentar
          </button>
        </div>
        <SaveIndicator status={saveStatus} onRetry={actions.retrySave} onCopy={copyContent} />
        <EditorSyncNotice session={session} songId={song.id} arrangementId={arrangement.id} onBeforeReload={actions.flush} onReload={onReload} />
      </header>

      <SongFields key={song.id} song={song} actions={actions} />
      <LyricsPanel song={song} actions={actions} currentSlides={occurrences.length} />
      <SectionsPanel sections={song.sections} actions={actions} />

      <section aria-labelledby="arranjo" className="flex flex-col gap-4">
        <h2 id="arranjo" className="text-lg font-semibold">
          Arranjo e slides
        </h2>
        <ArrangementFields state={state} actions={actions} session={session} />

        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Edição dos slides">
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={!state.canUndo} onClick={actions.undo}>
            ↶ Desfazer
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={!state.canRedo} onClick={actions.redo}>
            ↷ Refazer
          </button>
          <span className="text-sm text-muted" data-testid="occurrence-count">
            {occurrences.length} {occurrences.length === 1 ? 'slide' : 'slides'}
          </span>
        </div>

        {selected.length > 0 && (
          <SelectionBar
            count={selected.length}
            onMerge={() => {
              if (actions.merge(selected)?.ok) setSelection([]);
            }}
            onRepeat={() => actions.repeat(selected)}
            onDuration={(durationMs) => actions.setDuration(selected, durationMs)}
            onClear={() => setSelection([])}
          />
        )}

        {notice && (
          <div role="alert" data-testid="editor-notice" data-kind={notice.kind} className="flex items-start justify-between gap-3 rounded-lg border border-border-strong p-3 text-sm">
            <div>
              {notice.kind === 'error' ? (
                <p>{EDIT_ERROR_TEXT[notice.code]}</p>
              ) : (
                notice.codes.map((code) => <p key={code}>Revisar: {EDIT_REVIEW_TEXT[code]}</p>)
              )}
            </div>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={actions.dismissNotice}>
              Fechar
            </button>
          </div>
        )}

        {occurrences.length === 0 ? (
          <p className="text-muted">Este arranjo não tem slides. Escreva a letra e use &ldquo;Regenerar slides&rdquo;.</p>
        ) : (
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Slides do arranjo">
            {occurrences.map((occurrence, index) => (
              <OccurrenceCard
                key={occurrence.id}
                occurrence={occurrence}
                index={index}
                total={occurrences.length}
                visual={visual}
                maxLines={maxLines}
                selected={selected.includes(occurrence.id)}
                equivalents={equivalentOccurrenceIds(arrangement, occurrence.id)}
                onSelect={(checked) => setSelection(checked ? [...selected, occurrence.id] : selected.filter((id) => id !== occurrence.id))}
                actions={actions}
              />
            ))}
          </ol>
        )}
      </section>

      <AudioSection session={session} arrangement={arrangement} onChange={actions.updateAudio} />
    </div>
  );
}

function SelectionBar(props: { count: number; onMerge: () => void; onRepeat: () => void; onDuration: (durationMs: number | null) => void; onClear: () => void }) {
  const [seconds, setSeconds] = useState('8');
  const durationMs = parseTimerSeconds(seconds);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-accent p-3 text-sm" role="group" aria-label="Ações para os slides selecionados" data-testid="selection-bar">
      <span className="font-semibold">
        {props.count} {props.count === 1 ? 'selecionado' : 'selecionados'}
      </span>
      <button type="button" className={buttonClass('secondary', 'sm')} disabled={props.count < 2} onClick={props.onMerge}>
        Unir
      </button>
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={props.onRepeat}>
        Repetir trecho
      </button>
      <div className="w-24">
        <Label htmlFor="tempo-selecao">Segundos</Label>
        <Input id="tempo-selecao" inputMode="decimal" value={seconds} onChange={(event) => setSeconds(event.target.value)} className="px-2 py-1.5" />
      </div>
      <button type="button" className={buttonClass('secondary', 'sm')} disabled={durationMs === null} onClick={() => durationMs !== null && props.onDuration(durationMs)}>
        Aplicar tempo aos selecionados
      </button>
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => props.onDuration(null)}>
        Remover tempo dos selecionados
      </button>
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={props.onClear}>
        Limpar seleção
      </button>
    </div>
  );
}

type ReadyState = Extract<ReturnType<typeof useEditor>['state'], { status: 'ready' }>;

function SongFields({ song, actions }: { song: ReadyState['song']; actions: EditorActions }) {
  // Rascunhos locais: título vazio e listas em digitação não vão para o documento.
  const [title, setTitle] = useState(song.title);
  const [authors, setAuthors] = useState(song.authors.join(', '));
  const [tags, setTags] = useState(song.tags.join(', '));

  return (
    <section aria-labelledby="dados" className="grid gap-4 md:grid-cols-2">
      <h2 id="dados" className="text-lg font-semibold md:col-span-2">
        Dados do louvor
      </h2>
      <div>
        <Label htmlFor="ed-titulo" required>
          Título
        </Label>
        <Input
          id="ed-titulo"
          value={title}
          required
          onChange={(event) => {
            setTitle(event.target.value);
            actions.updateSong({ title: event.target.value.trim() });
          }}
          error={title.trim() === '' ? `Informe o título. Enquanto isso continua valendo "${song.title}".` : undefined}
        />
      </div>
      <div>
        <Label htmlFor="ed-artista">Artista</Label>
        <Input id="ed-artista" value={song.artist ?? ''} onChange={(event) => actions.updateSong({ artist: event.target.value === '' ? null : event.target.value })} />
      </div>
      <div>
        <Label htmlFor="ed-autoria">Autoria (separe por vírgula)</Label>
        <Input
          id="ed-autoria"
          value={authors}
          onChange={(event) => {
            setAuthors(event.target.value);
            actions.updateSong({ authors: parseList(event.target.value) });
          }}
        />
      </div>
      <div>
        <Label htmlFor="ed-tom">Tom</Label>
        <Input id="ed-tom" value={song.musicalKey ?? ''} onChange={(event) => actions.updateSong({ musicalKey: event.target.value === '' ? null : event.target.value })} />
      </div>
      <div>
        <Label htmlFor="ed-etiquetas">Etiquetas (separe por vírgula)</Label>
        <Input
          id="ed-etiquetas"
          value={tags}
          onChange={(event) => {
            setTags(event.target.value);
            actions.updateSong({ tags: parseList(event.target.value) });
          }}
        />
      </div>
      <div>
        <Label htmlFor="ed-observacoes">Observações</Label>
        <Input id="ed-observacoes" value={song.notes} onChange={(event) => actions.updateSong({ notes: event.target.value })} />
      </div>
    </section>
  );
}

function LyricsPanel({ song, actions, currentSlides }: { song: ReadyState['song']; actions: EditorActions; currentSlides: number }) {
  const [preview, setPreview] = useState<ReturnType<EditorActions['previewRegeneration']>>(null);
  return (
    <section aria-labelledby="letra-original" className="flex flex-col gap-3">
      <h2 id="letra-original" className="text-lg font-semibold">
        Letra original
      </h2>
      <div>
        <Label htmlFor="ed-letra">Letra</Label>
        <Textarea
          id="ed-letra"
          rows={10}
          spellCheck={false}
          value={song.rawLyrics}
          aria-describedby="ed-letra-ajuda"
          onChange={(event) => {
            setPreview(null);
            actions.updateSong({ rawLyrics: event.target.value });
          }}
        />
        <p id="ed-letra-ajuda" className="mt-1 text-xs text-muted">
          A letra é guardada como você escreveu. Alterá-la não muda os slides: para refazer a sugestão, use o botão abaixo.
        </p>
      </div>
      {preview === null ? (
        <button type="button" className={buttonClass('secondary', 'sm', 'self-start')} onClick={() => setPreview(actions.previewRegeneration())}>
          Regenerar slides a partir da letra…
        </button>
      ) : (
        <div role="alertdialog" aria-label="Confirmar regeneração dos slides" className="flex flex-col gap-2 rounded-lg border border-border-strong p-3 text-sm" data-testid="regenerate-preview">
          <p>
            A nova sugestão tem {preview.parsed.sections.length} {preview.parsed.sections.length === 1 ? 'seção' : 'seções'} e {preview.occurrences.length}{' '}
            {preview.occurrences.length === 1 ? 'slide' : 'slides'}; hoje são {song.sections.length} e {currentSlides}.
          </p>
          <p>
            Ela substitui os slides atuais, com as edições manuais e os tempos. A versão de agora fica guardada neste
            dispositivo e &ldquo;Desfazer&rdquo; a traz de volta nesta edição.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              onClick={() => {
                actions.regenerate();
                setPreview(null);
              }}
            >
              Substituir pelos slides sugeridos
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setPreview(null)}>
              Manter como está
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SectionsPanel({ sections, actions }: { sections: ReadyState['song']['sections']; actions: EditorActions }) {
  const ordered = useMemo(() => [...sections].sort((a, b) => a.order - b.order), [sections]);
  return (
    <section aria-labelledby="secoes" className="flex flex-col gap-3">
      <h2 id="secoes" className="text-lg font-semibold">
        Seções sugeridas
      </h2>
      {ordered.length === 0 ? (
        <p className="text-muted">Nenhuma seção: a letra está vazia ou os slides ainda não foram gerados.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ordered.map((section) => {
            const uncertain = section.detection === 'suggested';
            return (
              <li key={section.id} data-testid="section" data-section-id={section.id} data-kind={section.kind} data-detection={section.detection} className="grid gap-2 rounded-lg border border-border bg-surface-raised p-3 md:grid-cols-[10rem_12rem_1fr]">
                <div>
                  <Label htmlFor={`sec-rotulo-${section.id}`}>Rótulo</Label>
                  <Input id={`sec-rotulo-${section.id}`} value={section.label} onChange={(event) => actions.updateSection(section.id, { label: event.target.value })} className="px-2 py-1.5" />
                </div>
                <div>
                  <Label htmlFor={`sec-tipo-${section.id}`}>Tipo</Label>
                  <Select id={`sec-tipo-${section.id}`} value={section.kind} onChange={(event) => actions.updateSection(section.id, { kind: event.target.value as SectionKind })} className="py-1.5">
                    {SECTION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {SECTION_KIND_LABEL[kind]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-0 text-sm">
                  <p className={uncertain ? 'font-semibold' : 'text-muted'} data-testid="section-detection">
                    {section.detection === 'explicit' && 'Marcador da letra'}
                    {section.detection === 'manual' && 'Revisado por você'}
                    {uncertain && '? Sugestão incerta — confira o tipo'}
                  </p>
                  <p className="truncate text-muted">{section.text.split('\n')[0] || '(sem letra)'}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Valor do seletor para a cópia de tema personalizado que o arranjo guarda sem um tema correspondente na lista. */
const OWN_COPY = 'copia';
const samePalette = (a: ThemeOverrides['palette'], b: ThemeOverrides['palette']) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function ArrangementFields({ state, actions, session }: { state: ReadyState; actions: EditorActions; session: LocalSession }) {
  const { arrangement, arrangements, song } = state;
  const [name, setName] = useState(arrangement.name);
  const [copyName, setCopyName] = useState<string | null>(null);
  const visual = resolveArrangementVisual(arrangement);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  useEffect(() => {
    void listThemes(session.db, session.profile.workspaceId).then(setCustomThemes);
  }, [session]);

  // O arranjo guarda uma cópia do tema personalizado (tema de base + diferenças); a paleta é o que o identifica.
  const ownPalette = arrangement.themeOverrides?.palette;
  const matching = ownPalette
    ? customThemes.find((theme) => {
        const applied = applyThemeToArrangement(theme, arrangement);
        return applied.themeRef.kind === 'builtin' && applied.themeRef.presetId === visual.preset.presetId && samePalette(applied.themeOverrides?.palette, ownPalette);
      })
    : undefined;
  const themeValue = matching ? `tema:${matching.id}` : ownPalette ? OWN_COPY : visual.preset.presetId;

  function chooseTheme(value: string) {
    if (value === OWN_COPY) return;
    // A proporção é do louvor, não do tema: continua a que estava.
    const aspectRatio = arrangement.themeOverrides?.aspectRatio;
    const custom = customThemes.find((theme) => `tema:${theme.id}` === value);
    if (custom) {
      const applied = applyThemeToArrangement(custom, arrangement);
      const overrides = { ...(applied.themeOverrides ?? {}), ...(aspectRatio ? { aspectRatio } : {}) };
      actions.updateArrangement({ ...applied, themeOverrides: Object.keys(overrides).length > 0 ? overrides : null });
      return;
    }
    // Tema de fábrica: fundo e letra vêm juntos dele; a cópia personalizada sai, a fonte escolhida à mão fica.
    actions.updateArrangement({ themeRef: { kind: 'builtin', presetId: value }, themeOverrides: aspectRatio ? { aspectRatio } : null });
  }

  async function open(arrangementId: Uuid) {
    await actions.flush();
    setLocalQuery({ view: 'editor', song: song.id, arranjo: arrangementId });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {arrangements.length > 1 && (
        <div className="md:col-span-2">
          <Label htmlFor="arr-seletor">Arranjo aberto</Label>
          <Select id="arr-seletor" value={arrangement.id} onChange={(event) => void open(event.target.value)}>
            {arrangements.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="arr-nome" required>
          Nome do arranjo
        </Label>
        <Input
          id="arr-nome"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            actions.updateArrangement({ name: event.target.value.trim() }, false);
          }}
          error={name.trim() === '' ? 'Informe o nome do arranjo.' : undefined}
        />
      </div>
      <div className="flex items-end">
        {copyName === null ? (
          <button type="button" className={buttonClass('secondary')} onClick={() => setCopyName(`${arrangement.name} (cópia)`)}>
            Duplicar arranjo…
          </button>
        ) : (
          <form
            className="flex w-full items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void actions.duplicateArrangement(copyName).then((id) => (id ? open(id) : undefined));
            }}
          >
            <div className="flex-1">
              <Label htmlFor="arr-copia">Nome da cópia</Label>
              <Input id="arr-copia" autoFocus value={copyName} onChange={(event) => setCopyName(event.target.value)} />
            </div>
            <button type="submit" className={buttonClass('primary')} disabled={copyName.trim() === ''}>
              Criar cópia
            </button>
            <button type="button" className={buttonClass()} onClick={() => setCopyName(null)}>
              Cancelar
            </button>
          </form>
        )}
      </div>
      <div>
        <Label htmlFor="arr-tema">Tema escuro</Label>
        <Select id="arr-tema" value={themeValue} onChange={(event) => chooseTheme(event.target.value)}>
          {themeValue === OWN_COPY && <option value={OWN_COPY}>Personalizado (cópia guardada neste louvor)</option>}
          <optgroup label="Temas de fábrica">
            {THEME_PRESETS.map((preset) => (
              <option key={preset.presetId} value={preset.presetId}>
                {preset.name}
              </option>
            ))}
          </optgroup>
          {customThemes.length > 0 && (
            <optgroup label="Temas personalizados">
              {customThemes.map((theme) => (
                <option key={theme.id} value={`tema:${theme.id}`}>
                  {theme.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      <div>
        <Label htmlFor="arr-fonte">Fonte</Label>
        <Select id="arr-fonte" value={arrangement.fontId ?? ''} onChange={(event) => actions.updateArrangement({ fontId: event.target.value === '' ? null : event.target.value })}>
          <option value="">Do tema ({BUNDLED_FONTS.find((font) => font.fontId === visual.preset.initialFontId)?.family})</option>
          {BUNDLED_FONTS.map((font) => (
            <option key={font.fontId} value={font.fontId}>
              {font.family}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="arr-proporcao">Proporção da projeção</Label>
        <Select
          id="arr-proporcao"
          value={visual.style.aspectRatio}
          onChange={(event) => actions.updateArrangement({ themeOverrides: { ...(arrangement.themeOverrides ?? {}), aspectRatio: event.target.value as AspectRatio } })}
        >
          {ASPECT_RATIOS.map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio}
            </option>
          ))}
        </Select>
      </div>
      {(visual.themeUnavailable || visual.fontUnavailable) && (
        <p role="alert" className="text-sm text-danger md:col-span-2" data-testid="visual-unavailable">
          {visual.themeUnavailable && 'O tema gravado neste arranjo não está disponível aqui; a prévia usa Preto acessível. '}
          {visual.fontUnavailable && 'A fonte gravada não faz parte deste aplicativo; a prévia usa Inter.'}
        </p>
      )}
    </div>
  );
}
