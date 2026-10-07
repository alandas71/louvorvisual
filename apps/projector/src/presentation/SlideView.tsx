import { slideModel, type SlideInput } from '@louvorvisual/presentation';
import type { CSSProperties } from 'react';

/**
 * Hospedeiro do SlideRenderer no projetor. Toda a aparência vem de
 * `slideModel`, o mesmo cálculo usado pelo editor, pelas miniaturas e pela
 * janela pública da web; aqui ele só ocupa a tela inteira.
 */
export function SlideView(input: SlideInput) {
  const model = slideModel(input);
  return (
    <div className="stage-slide" style={model.viewport as CSSProperties} data-slide-frame data-visual-mode={model.visualMode} data-rotation={model.rotation}>
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
