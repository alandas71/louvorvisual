import { DEFAULT_MAX_LINES_PER_SLIDE, type AspectRatio, type BundledFontId, type FontWeight, type ThemeStyle } from '@louvorvisual/domain';
import { fontStack } from './snapshot';

/** Composição de referência; as medidas do tema valem para estas dimensões. */
export const REFERENCE_SIZE: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
};

/** A saída alterna somente entre paisagem e retrato. */
export const ROTATIONS = [0, 90] as const;
export type Rotation = (typeof ROTATIONS)[number];

export function isRotation(value: unknown): value is Rotation {
  return (ROTATIONS as readonly unknown[]).includes(value);
}

export function nextRotation(rotation: Rotation): Rotation {
  return rotation === 0 ? 90 : 0;
}

/** `normal` mostra a letra; `black` cobre tudo de preto; `lyricsHidden` mantém só o fundo do tema. */
export type VisualMode = 'normal' | 'black' | 'lyricsHidden';

export type SlideInput = {
  text: string;
  style: ThemeStyle;
  fontId: BundledFontId;
  visualMode?: VisualMode;
  rotation?: Rotation;
};

type Css = Record<string, string | number>;

/**
 * Descrição de um slide pronta para qualquer hospedeiro (React no web, DOM
 * puro no projetor): quatro elementos aninhados e o estilo de cada um. Só
 * decide aparência; tempo e áudio não passam por aqui.
 */
export type SlideModel = {
  /** Ocupa a área da saída e a pinta com o fundo. */
  viewport: Css;
  /** Composição na proporção do tema, girada e escalada para caber inteira. */
  composition: Css;
  /** Área útil dentro das margens de segurança. */
  content: Css;
  text: Css;
  /** Texto a desenhar; vazio quando a saída está preta ou com a letra oculta. */
  displayText: string;
  rotation: Rotation;
  visualMode: VisualMode;
};

const JUSTIFY = { top: 'flex-start', center: 'center', bottom: 'flex-end' } as const;
const SHADOW = { none: 'none', soft: '0 0.2cqw 0.8cqw rgba(0,0,0,0.6)', strong: '0 0.3cqw 0.4cqw rgba(0,0,0,0.9)' } as const;

/**
 * SlideRenderer: o mesmo cálculo para miniaturas, prévia e projeção. A
 * composição é dimensionada em unidades do contêiner, então a mesma descrição
 * serve a qualquer tamanho de saída sem medir a tela em JavaScript.
 */
export function slideModel(input: SlideInput): SlideModel {
  const { style } = input;
  const rotation = input.rotation ?? 0;
  const visualMode = input.visualMode ?? 'normal';
  const reference = REFERENCE_SIZE[style.aspectRatio];
  const sideways = rotation === 90;
  // Largura da composição antes de girar: a maior que cabe inteira na saída.
  const width = sideways
    ? `min(100cqh, calc(100cqw * ${reference.width} / ${reference.height}))`
    : `min(100cqw, calc(100cqh * ${reference.width} / ${reference.height}))`;
  const unit = 100 / reference.width;
  const black = visualMode === 'black';
  const backgroundColor = black ? '#000000' : style.palette.backgroundColor;

  return {
    viewport: { position: 'relative', overflow: 'hidden', containerType: 'size', backgroundColor },
    composition: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width,
      aspectRatio: `${reference.width} / ${reference.height}`,
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      containerType: 'size',
      backgroundColor,
      color: style.palette.textColor,
    },
    content: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      justifyContent: JUSTIFY[style.verticalAlign],
      textAlign: style.textAlign,
      padding: `${style.margins.verticalPercent}cqh ${style.margins.horizontalPercent}cqw`,
      fontFamily: fontStack(input.fontId),
      fontWeight: style.fontWeight,
      fontSize: `${style.fontSizePx * unit}cqw`,
      lineHeight: style.lineHeight,
      // Pesos reais do pacote: o navegador não deve inventar negrito.
      fontSynthesis: 'none',
    },
    text: {
      margin: 0,
      whiteSpace: 'pre-line',
      overflowWrap: 'break-word',
      textShadow: SHADOW[style.shadow],
      ...(style.outline ? { WebkitTextStroke: `${style.outline.widthPx * unit}cqw ${style.outline.color}`, paintOrder: 'stroke fill' } : {}),
      visibility: visualMode === 'normal' ? 'visible' : 'hidden',
    },
    displayText: visualMode === 'normal' ? input.text : '',
    rotation,
    visualMode,
  };
}

/** Largura, em px da composição de referência, de um texto na fonte indicada. */
export type TextMeasurer = (text: string, font: { fontId: BundledFontId; weight: FontWeight; sizePx: number }) => number;

export type SlideFit = {
  /** Linhas visuais depois da quebra automática, por linha de texto. */
  linesPerTextLine: number[];
  visualLines: number;
  /** Linhas que cabem na altura útil com este tamanho e entrelinha. */
  capacity: number;
  /** Uma palavra sozinha é mais larga que a área útil. */
  wordTooWide: boolean;
  /** O texto seria cortado: passa da altura útil ou tem palavra larga demais. */
  overflows: boolean;
  /** Passa das quatro linhas visuais sugeridas, mesmo cabendo. */
  exceedsSuggested: boolean;
};

/** Linhas visuais de uma linha de texto, quebrando entre palavras como o navegador. */
export function wrappedLineCount(line: string, maxWidth: number, measure: (text: string) => number): { lines: number; wordTooWide: boolean } {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: 1, wordTooWide: false };
  let lines = 1;
  let current = '';
  let wordTooWide = false;
  for (const word of words) {
    if (measure(word) > maxWidth) wordTooWide = true;
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && measure(candidate) > maxWidth) {
      lines += 1;
      current = word;
    } else {
      current = candidate;
    }
  }
  return { lines, wordTooWide };
}

/**
 * Confere se o texto cabe na área útil, medindo com a família e o peso exatos.
 * Usado pelo aviso de excesso do editor, pela divisão em slides e antes de
 * A+/troca de fonte ao vivo.
 */
export function measureSlideFit(input: Pick<SlideInput, 'text' | 'style' | 'fontId'>, measure: TextMeasurer): SlideFit {
  const { style } = input;
  const reference = REFERENCE_SIZE[style.aspectRatio];
  const usableWidth = reference.width * (1 - (2 * style.margins.horizontalPercent) / 100);
  const usableHeight = reference.height * (1 - (2 * style.margins.verticalPercent) / 100);
  const font = { fontId: input.fontId, weight: style.fontWeight, sizePx: style.fontSizePx };
  let wordTooWide = false;
  const linesPerTextLine = input.text.split('\n').map((line) => {
    const wrapped = wrappedLineCount(line, usableWidth, (text) => measure(text, font));
    wordTooWide ||= wrapped.wordTooWide;
    return wrapped.lines;
  });
  const visualLines = linesPerTextLine.reduce((sum, lines) => sum + lines, 0);
  const capacity = Math.max(1, Math.floor(usableHeight / (style.fontSizePx * style.lineHeight) + 1e-9));
  return {
    linesPerTextLine,
    visualLines,
    capacity,
    wordTooWide,
    overflows: wordTooWide || visualLines > capacity,
    exceedsSuggested: visualLines > Math.min(capacity, DEFAULT_MAX_LINES_PER_SLIDE),
  };
}
