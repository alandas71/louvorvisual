'use client';

import type { FontWeight } from '@louvorvisual/domain';
import { fontFileUrl, fontPack } from '@/presentation/fontPack';

export type FontFaceCheck = {
  family: string;
  weight: FontWeight;
  file: string;
  /** Os bytes recebidos têm o hash do manifesto. */
  intact: boolean;
  /** O navegador carregou este arquivo como a face declarada. */
  loaded: boolean;
};

const SAMPLE = 'áàâãéêíóôõúüç ÁÀÂÃÉÊÍÓÔÕÚÜÇ';

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Confere as dezesseis faces: lê cada arquivo (do cache do aplicativo, quando
 * instalado), compara com o hash do manifesto e pede ao navegador que carregue
 * a face. `loaded` só é verdadeiro para a face declarada pelo aplicativo, de
 * modo que uma fonte de sistema com o mesmo nome não conta.
 */
export async function checkFontPack(): Promise<FontFaceCheck[]> {
  const checks = fontPack.fonts.flatMap((font) =>
    font.faces.map(async (face): Promise<FontFaceCheck> => {
      const base = { family: font.family, weight: face.weight, file: face.file };
      try {
        const response = await fetch(fontFileUrl(face.file));
        const intact = response.ok && (await sha256Hex(await response.arrayBuffer())) === face.sha256;
        const faces = await document.fonts.load(`${face.weight} 48px "${font.family}"`, SAMPLE);
        const loaded = faces.some(
          (item) => item.status === 'loaded' && item.weight === String(face.weight) && item.family.replace(/["']/g, '') === font.family,
        );
        return { ...base, intact, loaded };
      } catch {
        return { ...base, intact: false, loaded: false };
      }
    }),
  );
  return Promise.all(checks);
}
