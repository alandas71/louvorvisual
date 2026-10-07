'use client';

import type { ReactNode } from 'react';
import { useFocusLayer } from '@/input/focus';

type DialogProps = { name: string; title: string; onBack: () => void; children?: ReactNode; actions: ReactNode; testId?: string };

/** Pergunta sobre a tela atual. É a camada mais alta: enquanto existe, só ela recebe teclas. */
export function Dialog({ name, title, onBack, children, actions, testId }: DialogProps) {
  const ref = useFocusLayer({ name, level: 9, repeat: 'directions', onBack });
  return (
    <div className="scrim" ref={ref} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} data-layer={name}>
      <div className="dialog">
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
