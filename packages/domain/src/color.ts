/** Critérios de planejamento/07: fundo escuro e contraste aprimorado. */
export const MAX_BACKGROUND_LUMINANCE = 0.1;
export const MIN_CONTRAST_RATIO = 7;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

function channel(hex: string, start: number): number {
  const srgb = parseInt(hex.slice(start, start + 2), 16) / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Luminância relativa sRGB (WCAG) de uma cor `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) throw new RangeError(`Cor inválida: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
