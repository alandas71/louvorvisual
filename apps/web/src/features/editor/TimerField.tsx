'use client';

import { formatTimerSeconds, parseTimerSeconds, stepTimerSeconds, TIMER_SUGGESTION_MS } from '@louvorvisual/domain';
import { useId, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';

type TimerFieldProps = {
  /** Como o slide é chamado nos rótulos acessíveis, ex.: "slide 3". */
  target: string;
  durationMs: number | null;
  onChange: (durationMs: number | null) => void;
};

/**
 * Tempo da ocorrência, direto na miniatura. Sem tempo mostra "Sem temporizador"
 * e "+ Tempo"; o campo abre com a sugestão de 8 s, que só vale depois de aplicada.
 */
export function TimerField({ target, durationMs, onChange }: TimerFieldProps) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseTimerSeconds(draft) === null;

  function apply() {
    if (draft === null) return;
    const parsed = parseTimerSeconds(draft);
    if (parsed === null) return;
    onChange(parsed);
    setDraft(null);
  }

  if (draft === null) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="timer" data-duration-ms={durationMs ?? 'null'}>
        {durationMs === null ? (
          <>
            <span className="text-muted">Sem temporizador</span>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(formatTimerSeconds(TIMER_SUGGESTION_MS))} aria-label={`Adicionar tempo ao ${target}`}>
              + Tempo
            </button>
          </>
        ) : (
          <>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(formatTimerSeconds(durationMs))} aria-label={`Alterar tempo do ${target}: ${formatTimerSeconds(durationMs)} segundos`}>
              ⏱ {formatTimerSeconds(durationMs)} s
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => onChange(null)} aria-label={`Remover tempo do ${target}`}>
              Remover tempo
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 text-xs"
      data-testid="timer"
      data-duration-ms={durationMs ?? 'null'}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDraft(null);
      }}
    >
      <label htmlFor={inputId} className="font-semibold text-muted">
        Tempo do {target}, em segundos
      </label>
      <div className="flex items-start gap-1">
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(stepTimerSeconds(draft, -1))} aria-label="Diminuir um segundo">
          −
        </button>
        <Input
          id={inputId}
          autoFocus
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="px-2 py-1.5 text-center"
          error={invalid ? 'Use de 0,5 a 600 segundos.' : undefined}
        />
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(stepTimerSeconds(draft, 1))} aria-label="Aumentar um segundo">
          +
        </button>
      </div>
      <div className="flex gap-1">
        <button type="submit" className={buttonClass('primary', 'sm')} disabled={invalid}>
          Aplicar
        </button>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft(null)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
