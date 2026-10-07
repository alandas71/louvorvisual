'use client';

import type { SlideOccurrence, Uuid } from '@louvorvisual/domain';
import { useId, useState } from 'react';
import { SlideView } from '@/components/SlideView';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils';
import { useSlideFit } from '@/presentation/measure';
import { TimerField } from './TimerField';
import type { EditorActions } from './useEditor';
import type { ArrangementVisual } from './visual';

type OccurrenceCardProps = {
  occurrence: SlideOccurrence;
  index: number;
  total: number;
  visual: ArrangementVisual;
  maxLines: number;
  selected: boolean;
  /** Outras ocorrências com o mesmo texto agora; o cartão as fixa ao abrir a edição. */
  equivalents: Uuid[];
  onSelect: (selected: boolean) => void;
  actions: EditorActions;
};

export function OccurrenceCard({ occurrence, index, total, visual, maxLines, selected, equivalents, onSelect, actions }: OccurrenceCardProps) {
  const textId = useId();
  const [mode, setMode] = useState<'view' | 'edit' | 'split'>('view');
  const [editTargets, setEditTargets] = useState<Uuid[]>([]);
  // Fixado ao abrir a edição: depois da primeira tecla os textos já diferem.
  const [knownEquivalents, setKnownEquivalents] = useState<Uuid[]>([]);
  const position = index + 1;
  const target = `slide ${position}`;
  const lines = occurrence.text.split('\n');
  const style = { ...visual.style, ...(occurrence.visualOverrides ?? {}) };
  // Linhas visuais medidas com a fonte carregada; enquanto ela carrega, vale a contagem das linhas de texto.
  const fit = useSlideFit({ text: occurrence.text, style, fontId: visual.fontId });
  const visualLines = fit?.visualLines ?? lines.length;
  const excess = visualLines > maxLines;

  return (
    <li
      data-testid="occurrence"
      data-occurrence-id={occurrence.id}
      data-section-id={occurrence.sourceSectionId ?? ''}
      className={cn('flex flex-col gap-3 rounded-2xl border bg-surface-overlay/50 p-3 transition-colors duration-150', selected ? 'border-accent bg-accent/5' : 'border-border hover:border-border-strong')}
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <label className="flex min-w-0 cursor-pointer items-center gap-2 font-semibold">
          <input type="checkbox" className="h-[18px] w-[18px] shrink-0 accent-accent" checked={selected} onChange={(event) => onSelect(event.target.checked)} aria-label={`Selecionar ${target}`} />
          <span className="truncate" data-testid="occurrence-label">
            {position} · {occurrence.label || 'Sem rótulo'}
          </span>
        </label>
        <div className="flex gap-1">
          <button type="button" className={buttonClass('ghost', 'sm', 'px-2')} disabled={index === 0} onClick={() => actions.move(occurrence.id, index - 1)} aria-label={`Mover ${target} para antes`}>
            ↑
          </button>
          <button type="button" className={buttonClass('ghost', 'sm', 'px-2')} disabled={index === total - 1} onClick={() => actions.move(occurrence.id, index + 1)} aria-label={`Mover ${target} para depois`}>
            ↓
          </button>
        </div>
      </div>

      <SlideView text={occurrence.text} style={style} fontId={visual.fontId} className="w-full overflow-hidden rounded-xl border border-border" />

      {occurrence.visualKind === 'instrumental' && <p className="text-xs text-muted">Slide sem letra (instrumental).</p>}
      {excess && (
        <p className="rounded-lg bg-danger/10 px-2.5 py-2 text-xs text-danger" data-testid="occurrence-excess" data-visual-lines={visualLines} data-overflows={fit?.overflows ?? false}>
          {fit?.overflows
            ? `Atenção: o texto não cabe neste tamanho de letra (${visualLines} linhas na tela, cabem ${fit.capacity}). Divida o slide ou reduza a letra.`
            : visualLines > lines.length
              ? `Atenção: com as quebras automáticas são ${visualLines} linhas na tela; o sugerido para este tema é até ${maxLines}.`
              : `Atenção: ${lines.length} linhas; o sugerido para este tema é até ${maxLines}.`}
        </p>
      )}

      <TimerField target={target} durationMs={occurrence.durationMs} onChange={(durationMs) => actions.setDuration([occurrence.id], durationMs)} />

      {mode === 'view' && (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => {
              setEditTargets([occurrence.id]);
              setKnownEquivalents(equivalents);
              setMode('edit');
            }}
            aria-label={`Editar texto do ${target}`}
          >
            Editar texto
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} disabled={lines.length < 2} onClick={() => setMode('split')} aria-label={`Dividir ${target}`}>
            Dividir
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => actions.repeat([occurrence.id])} aria-label={`Repetir ${target}`}>
            Repetir
          </button>
          <button type="button" className={buttonClass('ghost', 'sm', 'hover:text-danger')} onClick={() => actions.remove([occurrence.id])} aria-label={`Remover ${target}`}>
            Remover
          </button>
        </div>
      )}

      {mode === 'edit' && (
        <div className="flex flex-col gap-2">
          <label htmlFor={textId} className="text-xs font-semibold text-muted">
            Texto do {target}
          </label>
          <Textarea id={textId} autoFocus rows={Math.max(3, lines.length + 1)} value={occurrence.text} spellCheck={false} onChange={(event) => actions.editText(editTargets, event.target.value)} />
          {knownEquivalents.length > 0 && editTargets.length === 1 && (
            <button
              type="button"
              className={buttonClass('secondary', 'sm', 'self-start')}
              onClick={() => {
                const targets = [occurrence.id, ...knownEquivalents];
                setEditTargets(targets);
                actions.editText(targets, occurrence.text);
              }}
            >
              Aplicar também {knownEquivalents.length === 1 ? 'ao outro slide igual' : `aos outros ${knownEquivalents.length} slides iguais`}
            </button>
          )}
          {editTargets.length > 1 && <p className="text-xs text-muted">Editando {editTargets.length} slides com o mesmo texto.</p>}
          <button type="button" className={buttonClass('primary', 'sm', 'self-start')} onClick={() => setMode('view')}>
            Concluir
          </button>
        </div>
      )}

      {mode === 'split' && (
        <div className="flex flex-col gap-1 text-xs" role="group" aria-label={`Onde dividir o ${target}`}>
          {lines.map((line, lineIndex) => (
            <div key={lineIndex} className="flex flex-col gap-1">
              {lineIndex > 0 && (
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => {
                    actions.split(occurrence.id, lineIndex);
                    setMode('view');
                  }}
                  aria-label={`Dividir depois da linha ${lineIndex}`}
                >
                  ✂ Dividir aqui
                </button>
              )}
              <span className="truncate text-muted">{line || '(linha vazia)'}</span>
            </div>
          ))}
          <button type="button" className={buttonClass('secondary', 'sm', 'self-start')} onClick={() => setMode('view')}>
            Cancelar
          </button>
        </div>
      )}
    </li>
  );
}
