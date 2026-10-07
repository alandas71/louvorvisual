'use client';

import {
  BUNDLED_FONTS,
  contrastRatio,
  createThemeCopy,
  FONT_SIZE_PX,
  isBundledFontId,
  isHexColor,
  LINE_HEIGHT,
  MARGIN_PERCENT,
  paletteIssues,
  RECOVERY_FONT_ID,
  THEME_PRESETS,
  themeStyleOf,
  touch,
  type PaletteIssue,
  type Shadow,
  type TextAlign,
  type Theme,
  type ThemePreset,
  type VerticalAlign,
} from '@louvorvisual/domain';
import { useCallback, useEffect, useState } from 'react';
import { SlideView } from '@/components/SlideView';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { deleteTheme, listThemes, LocalSaveError, saveTheme, useLocalSession, type LocalSession } from '@/local';
import { fontStack } from '@/presentation/fontPack';
import { SAMPLE_SLIDE_TEXT } from '../shell/selection';

const PALETTE_ISSUE_TEXT: Record<PaletteIssue, string> = {
  'invalid-color': 'Use cores no formato #RRGGBB, por exemplo #111827.',
  'background-not-dark': 'O fundo está claro demais. Os slides usam só fundo escuro: escolha uma cor mais escura.',
  'low-contrast': 'A letra não se destaca do fundo. Escolha uma letra mais clara: o mínimo é 7:1 de contraste.',
};

const TEXT_ALIGN_TEXT: Record<TextAlign, string> = { left: 'À esquerda', center: 'Centralizado', right: 'À direita' };
const VERTICAL_ALIGN_TEXT: Record<VerticalAlign, string> = { top: 'No alto', center: 'No meio', bottom: 'Embaixo' };
const SHADOW_TEXT: Record<Shadow, string> = { none: 'Sem sombra', soft: 'Sombra suave', strong: 'Sombra forte' };

/** A fonte do tema, ou a de recuperação quando o tema veio com uma fonte que este aplicativo não tem. */
const fontOf = (theme: Theme) => (isBundledFontId(theme.fontId) ? theme.fontId : RECOVERY_FONT_ID);

/** Nome livre para a cópia: "Grafite (cópia)", "Grafite (cópia 2)"… */
function copyName(preset: ThemePreset, existing: readonly Theme[]): string {
  const names = new Set(existing.map((theme) => theme.name));
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? `${preset.name} (cópia)` : `${preset.name} (cópia ${attempt})`;
    if (!names.has(name)) return name;
  }
}

/** Temas personalizados: cópias editáveis dos temas de fábrica, guardadas com a biblioteca. */
export function CustomThemes() {
  const local = useLocalSession();
  if (local.status !== 'ready') return null;
  return <CustomThemesReady session={local.session} />;
}

function CustomThemesReady({ session }: { session: LocalSession }) {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [base, setBase] = useState<string>(THEME_PRESETS[0]!.presetId);
  const [message, setMessage] = useState('');

  const reload = useCallback(() => listThemes(session.db, session.profile.workspaceId).then(setThemes), [session]);
  useEffect(() => {
    void listThemes(session.db, session.profile.workspaceId).then(setThemes);
  }, [session]);

  const duplicate = async () => {
    const preset = THEME_PRESETS.find((item) => item.presetId === base) ?? THEME_PRESETS[0]!;
    const theme = createThemeCopy(preset, copyName(preset, themes), session.context());
    await saveTheme(session.db, theme);
    await reload();
    setEditingId(theme.id);
    setMessage(`"${theme.name}" criado. O tema de fábrica continua como era.`);
  };

  const editing = themes.find((theme) => theme.id === editingId) ?? null;

  return (
    <section aria-labelledby="temas-personalizados" className="flex flex-col gap-4" data-testid="custom-themes">
      <div>
        <h2 id="temas-personalizados" className="text-lg font-semibold">
          Temas personalizados
        </h2>
        <p className="mt-1 text-sm text-muted">
          Um tema personalizado começa como cópia de um tema de fábrica. Para usar, abra o louvor no editor e escolha o tema em &ldquo;Tema
          escuro&rdquo;: o louvor guarda a própria cópia, então mudar ou excluir o tema depois não altera o que já foi preparado.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="tema-base">Copiar de</Label>
          <Select id="tema-base" value={base} onChange={(event) => setBase(event.target.value)}>
            {THEME_PRESETS.map((preset) => (
              <option key={preset.presetId} value={preset.presetId}>
                {preset.name}
              </option>
            ))}
          </Select>
        </div>
        <button type="button" className={buttonClass('secondary')} onClick={() => void duplicate()}>
          Duplicar tema
        </button>
      </div>

      <p role="status" className="text-sm text-muted" data-testid="custom-theme-message">
        {message}
      </p>

      {themes.length === 0 ? (
        <p className="text-sm text-muted">Nenhum tema personalizado ainda.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="custom-theme-list">
          {themes.map((theme) => (
            <li key={theme.id}>
              <button
                type="button"
                aria-pressed={theme.id === editingId}
                onClick={() => setEditingId(theme.id === editingId ? null : theme.id)}
                className={`w-full rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${theme.id === editingId ? 'border-accent' : 'border-border-strong'}`}
                style={{ backgroundColor: theme.palette.backgroundColor, color: theme.palette.textColor }}
                data-testid="custom-theme"
              >
                <span className="block text-base font-bold" style={{ fontFamily: fontStack(fontOf(theme)) }}>
                  {theme.name}
                </span>
                <span className="block text-xs" style={{ fontFamily: fontStack(fontOf(theme)) }}>
                  Glória e gratidão
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ThemeForm
          key={editing.id}
          theme={editing}
          session={session}
          onSaved={async (name) => {
            await reload();
            setMessage(`"${name}" salvo neste dispositivo.`);
          }}
          onDeleted={async (name) => {
            setEditingId(null);
            await reload();
            setMessage(`"${name}" excluído. Os louvores que já usavam este tema não mudam.`);
          }}
        />
      )}
    </section>
  );
}

function ThemeForm({ theme, session, onSaved, onDeleted }: { theme: Theme; session: LocalSession; onSaved: (name: string) => Promise<void>; onDeleted: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState<Theme>(theme);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (fields: Partial<Theme>) => {
    setDraft((current) => ({ ...current, ...fields }));
    setError('');
  };
  const issues = paletteIssues(draft.palette);
  const nameMissing = draft.name.trim() === '';
  const colorsValid = isHexColor(draft.palette.backgroundColor) && isHexColor(draft.palette.textColor);
  const changed = JSON.stringify(draft) !== JSON.stringify(theme);

  const save = async () => {
    // A recusa aparece antes de tentar gravar; a gravação valida de novo pelo contrato.
    if (issues.length > 0 || nameMissing) return;
    try {
      const next = touch({ ...draft, name: draft.name.trim() }, session.context());
      await saveTheme(session.db, next);
      await onSaved(next.name);
    } catch (cause) {
      setError(cause instanceof LocalSaveError ? cause.message : 'Não foi possível salvar o tema.');
    }
  };

  const colorField = (id: string, label: string, key: 'backgroundColor' | 'textColor') => (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label}: seletor`}
          className="h-10 w-12 shrink-0 cursor-pointer rounded border border-border-strong bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          value={isHexColor(draft.palette[key]) ? draft.palette[key] : '#000000'}
          onChange={(event) => set({ palette: { ...draft.palette, [key]: event.target.value.toUpperCase() } })}
        />
        <Input id={id} value={draft.palette[key]} onChange={(event) => set({ palette: { ...draft.palette, [key]: event.target.value.trim() } })} autoComplete="off" spellCheck={false} maxLength={7} />
      </div>
    </div>
  );

  const numberField = (id: string, label: string, value: number, limits: { min: number; max: number }, step: number, apply: (value: number) => void) => (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={limits.min}
        max={limits.max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(next)) apply(Math.min(limits.max, Math.max(limits.min, next)));
        }}
      />
    </div>
  );

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4"
      aria-label={`Editar o tema ${theme.name}`}
      data-testid="custom-theme-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="tema-nome" required>
              Nome do tema
            </Label>
            <Input id="tema-nome" value={draft.name} onChange={(event) => set({ name: event.target.value })} error={nameMissing ? 'Informe o nome do tema.' : undefined} autoComplete="off" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {colorField('tema-fundo', 'Cor do fundo', 'backgroundColor')}
            {colorField('tema-letra', 'Cor da letra', 'textColor')}
          </div>
          <p className="text-sm" data-testid="custom-theme-contrast">
            {colorsValid ? `Contraste entre letra e fundo: ${contrastRatio(draft.palette.backgroundColor, draft.palette.textColor).toFixed(1)}:1.` : 'Contraste: informe as duas cores.'}
          </p>
          {issues.length > 0 && (
            <div role="alert">
              <ul className="list-disc space-y-1 pl-5 text-sm font-semibold text-danger" data-testid="custom-theme-issues">
                {issues.map((issue) => (
                  <li key={issue} data-issue={issue}>
                    ⚠ {PALETTE_ISSUE_TEXT[issue]}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Prévia</p>
          {issues.length === 0 ? (
            <SlideView text={SAMPLE_SLIDE_TEXT} style={themeStyleOf(draft)} fontId={fontOf(draft)} className="w-full rounded-lg border border-border" />
          ) : (
            <p className="rounded-lg border border-border p-4 text-sm text-muted">A prévia volta quando as cores forem aceitas.</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <div>
          <Label htmlFor="tema-fonte">Fonte</Label>
          <Select id="tema-fonte" value={draft.fontId} onChange={(event) => set({ fontId: event.target.value })}>
            {BUNDLED_FONTS.map((font) => (
              <option key={font.fontId} value={font.fontId}>
                {font.family}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="tema-peso">Peso</Label>
          <Select id="tema-peso" value={String(draft.fontWeight)} onChange={(event) => set({ fontWeight: event.target.value === '400' ? 400 : 700 })}>
            <option value="400">Regular</option>
            <option value="700">Negrito</option>
          </Select>
        </div>
        {numberField('tema-tamanho', 'Tamanho da letra (px)', draft.fontSizePx, FONT_SIZE_PX, FONT_SIZE_PX.step, (value) => set({ fontSizePx: Math.round(value) }))}
        {numberField('tema-entrelinha', 'Entrelinha', draft.lineHeight, LINE_HEIGHT, 0.05, (value) => set({ lineHeight: Math.round(value * 100) / 100 }))}
        <div>
          <Label htmlFor="tema-alinhamento">Alinhamento</Label>
          <Select id="tema-alinhamento" value={draft.textAlign} onChange={(event) => set({ textAlign: event.target.value as TextAlign })}>
            {(Object.keys(TEXT_ALIGN_TEXT) as TextAlign[]).map((value) => (
              <option key={value} value={value}>
                {TEXT_ALIGN_TEXT[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="tema-vertical">Posição na tela</Label>
          <Select id="tema-vertical" value={draft.verticalAlign} onChange={(event) => set({ verticalAlign: event.target.value as VerticalAlign })}>
            {(Object.keys(VERTICAL_ALIGN_TEXT) as VerticalAlign[]).map((value) => (
              <option key={value} value={value}>
                {VERTICAL_ALIGN_TEXT[value]}
              </option>
            ))}
          </Select>
        </div>
        {numberField('tema-margem-h', 'Margem lateral (%)', draft.margins.horizontalPercent, MARGIN_PERCENT, 1, (value) => set({ margins: { ...draft.margins, horizontalPercent: value } }))}
        {numberField('tema-margem-v', 'Margem em cima e embaixo (%)', draft.margins.verticalPercent, MARGIN_PERCENT, 1, (value) => set({ margins: { ...draft.margins, verticalPercent: value } }))}
        <div>
          <Label htmlFor="tema-sombra">Sombra da letra</Label>
          <Select id="tema-sombra" value={draft.shadow} onChange={(event) => set({ shadow: event.target.value as Shadow })}>
            {(Object.keys(SHADOW_TEXT) as Shadow[]).map((value) => (
              <option key={value} value={value}>
                {SHADOW_TEXT[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm font-semibold text-danger">
          ⚠ {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass('primary')} disabled={issues.length > 0 || nameMissing || !changed}>
          Salvar tema
        </button>
        {confirmDelete ? (
          <div role="alertdialog" aria-label="Confirmar exclusão do tema" className="flex flex-wrap items-center gap-3 text-sm">
            <p>Excluir &ldquo;{theme.name}&rdquo;? Os louvores que já usam este tema guardam a própria cópia e não mudam.</p>
            <button type="button" className={buttonClass('danger', 'sm')} onClick={() => void deleteTheme(session.db, theme.id, session.context()).then(() => onDeleted(theme.name))}>
              Excluir tema
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button type="button" className={buttonClass('danger', 'sm')} onClick={() => setConfirmDelete(true)}>
            Excluir tema…
          </button>
        )}
      </div>
    </form>
  );
}
