'use client';

import { slideModel, type OutputFrame, type SlideInput, type SlideModel } from '@louvorvisual/presentation';
import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type SlideViewProps = SlideInput & {
  /** `ratio`: o quadro assume a proporção do tema (miniaturas e prévias). `fill`: ocupa o elemento pai (saídas). */
  fit?: 'ratio' | 'fill';
  /** Abertura da apresentação: desenhada no lugar da letra, na mesma composição (proporção e rotação). */
  cover?: OutputFrame['cover'];
  /**
   * Identidade do que está na tela (slide ou abertura). Quando muda, o conteúdo
   * anterior some e o novo aparece em transição suave. Sem ela, a troca é seca
   * (miniaturas e prévias de edição).
   */
  transitionKey?: string;
  className?: string;
};

type Layer = { model: SlideModel; cover: OutputFrame['cover'] };

/** Letra ou abertura de um quadro. `leaving` é a camada que está saindo: sem marcas de leitura para testes e leitores de tela. */
function SlideLayer({ layer, animated, leaving = false, onGone }: { layer: Layer; animated: boolean; leaving?: boolean; onGone?: () => void }) {
  const { model, cover } = layer;
  const motion = leaving ? 'lv-slide-leave' : animated ? 'lv-slide-enter' : undefined;
  if (cover !== undefined && model.visualMode !== 'black') {
    return (
      <div className={cn('lv-cover', motion)} style={{ fontFamily: model.content.fontFamily as string }} aria-hidden={leaving || undefined} onAnimationEnd={leaving ? onGone : undefined} {...(leaving ? {} : { 'data-slide-cover': true })}>
        {model.visualMode === 'normal' && (
          <div className="lv-cover-text">
            <p className="lv-cover-title" {...(leaving ? {} : { 'data-cover-title': true })}>
              {cover.title}
            </p>
            {cover.artist && <p className="lv-cover-artist">{cover.artist}</p>}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={motion} style={{ ...(model.content as CSSProperties), ...(leaving ? { position: 'absolute', inset: 0 } : {}) }} aria-hidden={leaving || undefined} onAnimationEnd={leaving ? onGone : undefined}>
      <p style={model.text as CSSProperties} {...(leaving ? {} : { 'data-slide-text': true })}>
        {model.displayText}
      </p>
    </div>
  );
}

/**
 * Hospedeiro React do SlideRenderer. Toda a aparência vem de `slideModel`, o
 * mesmo usado por editor, miniaturas, prévia do operador e janela pública.
 */
export function SlideView({ fit = 'ratio', className, cover, transitionKey, ...input }: SlideViewProps) {
  const model = slideModel(input);
  // Tela preta cobre também a abertura; com a letra oculta ficam só as luzes, sem o título.
  const showCover = cover !== undefined && model.visualMode !== 'black';
  // As luzes da abertura seguem atrás da letra nas saídas, bem mais fracas. Miniaturas e prévias de edição só as mostram na abertura.
  const showLights = showCover || (transitionKey !== undefined && model.visualMode !== 'black');
  const layer: Layer = { model, cover };

  // Última camada desenhada: quando a identidade muda, ela vira a camada que sai.
  const signature = JSON.stringify([transitionKey, layer]);
  const [last, setLast] = useState({ key: transitionKey, signature, layer });
  const [leaving, setLeaving] = useState<{ key: string; layer: Layer } | null>(null);
  if (last.signature !== signature) {
    // Só há o que esmaecer entre dois quadros visíveis; tela preta e letra oculta trocam na hora.
    if (transitionKey !== undefined && last.key !== undefined && last.key !== transitionKey) {
      setLeaving(model.visualMode === 'normal' && last.layer.model.visualMode === 'normal' ? { key: last.key, layer: last.layer } : null);
    }
    setLast({ key: transitionKey, signature, layer });
  }

  const viewport: CSSProperties = {
    ...(model.viewport as CSSProperties),
    ...(fit === 'ratio' ? { aspectRatio: input.style.aspectRatio.replace(':', ' / ') } : {}),
  };
  return (
    <div className={cn(fit === 'fill' && 'h-full w-full', className)} style={viewport} data-slide-frame data-visual-mode={model.visualMode} data-rotation={model.rotation} data-cover={showCover || undefined}>
      <div style={model.composition as CSSProperties} data-slide-composition>
        {showLights && (
          <div className={cn('lv-lights', !showCover && 'lv-lights-soft')} aria-hidden="true" data-slide-lights={showCover ? 'cover' : 'soft'}>
            <div className="lv-cover-rays" />
            <div className="lv-cover-rays lv-cover-rays-slow" />
            <div className="lv-cover-glow" />
            <div className="lv-cover-motes" />
          </div>
        )}
        <SlideLayer key={transitionKey ?? 'static'} layer={layer} animated={transitionKey !== undefined} />
        {leaving && model.visualMode === 'normal' && <SlideLayer key={`saindo:${leaving.key}`} layer={leaving.layer} animated leaving onGone={() => setLeaving(null)} />}
      </div>
    </div>
  );
}
