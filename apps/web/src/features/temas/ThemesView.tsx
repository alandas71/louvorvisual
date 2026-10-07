'use client';

import { BUNDLED_FONTS, FONT_WEIGHTS, THEME_PRESETS } from '@louvorvisual/domain';
import { SlideView } from '@/components/SlideView';
import { setLocalQuery, useLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { fontStack } from '@/presentation/fontPack';
import { readVisualSelection, SAMPLE_SLIDE_TEXT } from '../shell/selection';
import { CustomThemes } from './CustomThemes';

const optionClass =
  'relative cursor-pointer rounded-2xl border-2 p-4 text-left transition-[border-color,transform] duration-150 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function ThemesView() {
  const query = useLocalQuery();
  const selection = readVisualSelection(query);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-[1.75rem] font-bold leading-tight md:text-3xl">Temas e fontes</h1>
      </header>

      <section aria-labelledby="previa" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-6">
        <h2 id="previa" className="text-lg font-bold">
          Prévia
        </h2>
        <SlideView
          text={SAMPLE_SLIDE_TEXT}
          style={{ ...selection.preset.style, fontWeight: selection.fontWeight }}
          fontId={selection.fontId}
          className="w-full max-w-3xl overflow-hidden rounded-2xl border border-border shadow-pop"
        />
      </section>

      <section aria-labelledby="temas" className="flex flex-col gap-3">
        <h2 id="temas" className="text-lg font-bold">
          Temas
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {THEME_PRESETS.map((preset) => {
            const selected = preset.presetId === selection.preset.presetId;
            return (
              <li key={preset.presetId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setLocalQuery({ tema: preset.presetId })}
                  className={cn(optionClass, 'flex aspect-video w-full flex-col justify-end', selected ? 'border-accent' : 'border-transparent hover:border-border-strong')}
                  style={{ backgroundColor: preset.style.palette.backgroundColor, color: preset.style.palette.textColor }}
                >
                  <span className="block text-base font-bold" style={{ fontFamily: fontStack(preset.initialFontId) }}>
                    {preset.name}
                  </span>
                  <span className="block text-xs" style={{ fontFamily: fontStack(preset.initialFontId) }}>
                    Glória e gratidão
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <CustomThemes />

      <section aria-labelledby="fontes" className="flex flex-col gap-3">
        <h2 id="fontes" className="text-lg font-bold">
          Fontes
        </h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {BUNDLED_FONTS.map((font) => {
            const selected = selection.fontChosen && font.fontId === selection.fontId;
            return (
              <li key={font.fontId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setLocalQuery({ fonte: font.fontId })}
                  className={cn(optionClass, 'w-full bg-surface-raised', selected ? 'border-accent' : 'border-border hover:border-border-strong')}
                >
                  <span className="mb-1 block text-xs font-semibold text-muted">{font.family}</span>
                  {FONT_WEIGHTS.map((weight) => (
                    <span key={weight} className="block text-xl" style={{ fontFamily: fontStack(font.fontId), fontWeight: weight }}>
                      Coração, louvação, fé e canção
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">Peso</legend>
            {FONT_WEIGHTS.map((weight) => (
              <label key={weight} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="peso"
                  className="accent-accent"
                  checked={selection.fontWeight === weight}
                  onChange={() => setLocalQuery({ peso: String(weight) })}
                />
                {weight === 400 ? 'Regular' : 'Negrito'}
              </label>
            ))}
          </fieldset>
          {selection.fontChosen && (
            <button
              type="button"
              onClick={() => setLocalQuery({ fonte: null })}
              className="font-semibold text-accent underline underline-offset-4"
            >
              Usar a fonte inicial do tema
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
