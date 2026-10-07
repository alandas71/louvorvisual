import { slideModel, type SlideInput } from '@louvorvisual/presentation';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type SlideViewProps = SlideInput & {
  /** `ratio`: o quadro assume a proporção do tema (miniaturas e prévias). `fill`: ocupa o elemento pai (saídas). */
  fit?: 'ratio' | 'fill';
  className?: string;
};

/**
 * Hospedeiro React do SlideRenderer. Toda a aparência vem de `slideModel`, o
 * mesmo usado por editor, miniaturas, prévia do operador e janela pública.
 */
export function SlideView({ fit = 'ratio', className, ...input }: SlideViewProps) {
  const model = slideModel(input);
  const viewport: CSSProperties = {
    ...(model.viewport as CSSProperties),
    ...(fit === 'ratio' ? { aspectRatio: input.style.aspectRatio.replace(':', ' / ') } : {}),
  };
  return (
    <div className={cn(fit === 'fill' && 'h-full w-full', className)} style={viewport} data-slide-frame data-visual-mode={model.visualMode} data-rotation={model.rotation}>
      <div style={model.composition as CSSProperties} data-slide-composition>
        <div style={model.content as CSSProperties}>
          <p style={model.text as CSSProperties} data-slide-text>
            {model.displayText}
          </p>
        </div>
      </div>
    </div>
  );
}
