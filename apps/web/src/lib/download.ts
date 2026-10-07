/** Entrega um arquivo gerado no dispositivo pelo fluxo de download do navegador. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // O navegador já tem a referência; liberar depois de um instante evita cortar o download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Espaço livre estimado para o aplicativo, ou `null` quando o navegador não informa. */
export async function freeSpaceEstimate(): Promise<number | null> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, estimate.quota - estimate.usage) : null;
}
