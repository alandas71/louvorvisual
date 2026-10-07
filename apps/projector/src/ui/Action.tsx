'use client';

import type { ReactNode } from 'react';
import { useAdjust } from '@/input/focus';

type ActionProps = {
  className?: string;
  /** Identifica o item para o foco voltar a ele quando a tela for reaberta. */
  focusKey?: string;
  /** Recebe o foco quando a camada abre. */
  autoFocus?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  label?: string;
  testId?: string;
  onSelect: () => void;
  onFocus?: () => void;
  style?: React.CSSProperties;
  children: ReactNode;
};

/**
 * Alvo de foco do controle remoto. É um botão comum, ativado por um único
 * caminho: o clique — do OK do controle (o gerenciador de foco chama `click()`)
 * ou de um ponteiro. Fica fora da ordem de Tab; quem move o foco são as setas.
 */
export function Action({ className, focusKey, autoFocus, disabled, pressed, label, testId, onSelect, onFocus, style, children }: ActionProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={className}
      data-focusable=""
      data-focus-key={focusKey}
      data-autofocus={autoFocus ? '' : undefined}
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      style={style}
      onClick={onSelect}
      onFocus={onFocus}
    >
      {children}
    </button>
  );
}

type AdjustProps = {
  label: string;
  value: string;
  testId?: string;
  autoFocus?: boolean;
  focusKey?: string;
  /** ← diminui, → aumenta; OK também aumenta, para quem não percebeu as setas. */
  onStep: (direction: 1 | -1) => void;
};

/** Campo de ajuste sem digitação: com o foco nele, esquerda e direita mudam o valor. */
export function Adjust({ label, value, testId, autoFocus, focusKey, onStep }: AdjustProps) {
  const ref = useAdjust<HTMLButtonElement>(onStep);
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      className="button adjust"
      data-focusable=""
      data-adjust=""
      data-focus-key={focusKey}
      data-autofocus={autoFocus ? '' : undefined}
      data-testid={testId}
      aria-label={`${label}: ${value}. Esquerda diminui, direita aumenta.`}
      onClick={() => onStep(1)}
    >
      <span>{label}</span>
      <span className="button-value">{value}</span>
    </button>
  );
}
