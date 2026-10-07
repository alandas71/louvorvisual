import { slideModel, type OutputFrame, type SlideInput } from '@louvorvisual/presentation';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type SlideViewProps = SlideInput & {
  /** `ratio`: o quadro assume a proporção do tema (miniaturas e prévias). `fill`: ocupa o elemento pai (saídas). */
  fit?: 'ratio' | 'fill';
  /** Abertura da apresentação: desenhada no lugar da letra, na mesma composição (proporção e rotação). */
  cover?: OutputFrame['cover'];
  className?: string;
};

/**
 * Hospedeiro React do SlideRenderer. Toda a aparência vem de `slideModel`, o
 * mesmo usado por editor, miniaturas, prévia do operador e janela pública.
 */
export function SlideView({ fit = 'ratio', className, cover, ...input }: SlideViewProps) {
  const model = slideModel(input);
  // Tela preta cobre também a abertura; com a letra oculta ficam só as luzes, sem o título.
  const showCover = cover !== undefined && model.visualMode !== 'black';
  const viewport: CSSProperties = {
    ...(model.viewport as CSSProperties),
    ...(fit === 'ratio' ? { aspectRatio: input.style.aspectRatio.replace(':', ' / ') } : {}),
    ...(showCover ? { backgroundColor: '#05060a' } : {}),
  };
  return (
    <div className={cn(fit === 'fill' && 'h-full w-full', className)} style={viewport} data-slide-frame data-visual-mode={model.visualMode} data-rotation={model.rotation} data-cover={showCover || undefined}>
      <div style={model.composition as CSSProperties} data-slide-composition>
        {showCover ? (
          <div className="lv-cover" data-slide-cover>
            <div className="lv-cover-rays" aria-hidden="true" />
            <div className="lv-cover-rays lv-cover-rays-slow" aria-hidden="true" />
            <div className="lv-cover-glow" aria-hidden="true" />
            <div className="lv-cover-motes" aria-hidden="true" />
            {model.visualMode === 'normal' && (
              <div className="lv-cover-text">
                <p className="lv-cover-title" data-cover-title>
                  {cover.title}
                </p>
                {cover.artist && <p className="lv-cover-artist">{cover.artist}</p>}
              </div>
            )}
          </div>
        ) : (
          <div style={model.content as CSSProperties}>
            <p style={model.text as CSSProperties} data-slide-text>
              {model.displayText}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
