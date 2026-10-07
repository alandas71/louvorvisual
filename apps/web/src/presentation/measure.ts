'use client';

import { bundledFont, type BundledFontId, type FontWeight } from '@louvorvisual/domain';
import { fontStack, measureSlideFit, type SlideFit, type SlideInput, type TextMeasurer } from '@louvorvisual/presentation';
import { useEffect, useState } from 'react';

const SAMPLE = 'áàâãéêíóôõúüç ÁÀÂÃÉÊÍÓÔÕÚÜÇ';

export type FontFaceStatus = 'loading' | 'ready' | 'missing';

const faces = new Map<string, Promise<boolean>>();

/**
 * Pede ao navegador a face exata (família e peso) do pacote embutido. Só conta
 * como carregada a face declarada pelo aplicativo; uma fonte de sistema com o
 * mesmo nome ou a reserva não passam.
 */
export function loadFontFace(fontId: BundledFontId, weight: FontWeight): Promise<boolean> {
  const key = `${fontId}:${weight}`;
  let pending = faces.get(key);
  if (!pending) {
    const { family } = bundledFont(fontId);
    pending = document.fonts.load(`${weight} 48px "${family}"`, SAMPLE).then(
      (loaded) => loaded.some((face) => face.status === 'loaded' && face.weight === String(weight) && face.family.replace(/["']/g, '') === family),
      () => false,
    );
    faces.set(key, pending);
    // Uma falha não fica guardada: a próxima consulta tenta de novo.
    void pending.then((ok) => {
      if (!ok) faces.delete(key);
    });
  }
  return pending;
}

export function useFontFace(fontId: BundledFontId, weight: FontWeight): FontFaceStatus {
  const key = `${fontId}:${weight}`;
  const [result, setResult] = useState<{ key: string; status: FontFaceStatus } | null>(null);
  useEffect(() => {
    let current = true;
    void loadFontFace(fontId, weight).then((ok) => current && setResult({ key, status: ok ? 'ready' : 'missing' }));
    return () => {
      current = false;
    };
  }, [fontId, weight, key]);
  return result?.key === key ? result.status : 'loading';
}

let context: CanvasRenderingContext2D | null = null;

/** Largura do texto na composição de referência, medida em canvas com a fonte já carregada. */
export const canvasMeasurer: TextMeasurer = (text, font) => {
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  context.font = `${font.weight} ${font.sizePx}px ${fontStack(font.fontId)}`;
  return context.measureText(text).width;
};

/** Mede o texto depois de carregar a família e o peso exatos; `null` enquanto carrega ou se a fonte falhou. */
export function useSlideFit(slide: Pick<SlideInput, 'text' | 'style' | 'fontId'>): SlideFit | null {
  const status = useFontFace(slide.fontId, slide.style.fontWeight);
  if (status !== 'ready') return null;
  return measureSlideFit(slide, canvasMeasurer);
}
