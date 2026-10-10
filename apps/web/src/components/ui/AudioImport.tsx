'use client';

import { AUDIO_FILE_ACCEPT, AUDIO_FORMAT_LABEL, MAX_ASSET_BYTES } from '@louvorvisual/domain';
import { useId, useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/utils';
import { buttonClass } from './buttonStyles';

/** Andamento real de uma importação, em bytes. */
export type ImportStatus = { label: string; loadedBytes: number; totalBytes: number };

type AudioImportProps = {
  /** Texto da área, ex.: "Importar playback". */
  label: string;
  /** Recebe o arquivo confirmado; rejeitar a promessa mostra a mensagem do erro. */
  onImport: (file: File, onProgress: (status: ImportStatus) => void) => Promise<void>;
  testId?: string;
};

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;

/**
 * Seleção de arquivo de áudio por clique, teclado ou arrastar. A interação
 * (área de soltar, campo oculto, estados de arrasto/erro) vem do `FileUpload`
 * do projeto de referência; o resto é próprio: o tamanho aparece antes de
 * importar e a barra mostra só bytes realmente processados, sem simulação.
 */
export function AudioImport({ label, onImport, testId }: AudioImportProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;

  function choose(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    setChosen(file);
  }

  function onDrag(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'dragenter' || event.type === 'dragover') setDragActive(true);
    else if (event.type === 'dragleave') setDragActive(false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    choose(event.dataTransfer.files?.[0]);
  }

  async function confirm() {
    if (!chosen || busy) return;
    setError(null);
    setStatus({ label: 'Preparando…', loadedBytes: 0, totalBytes: chosen.size });
    try {
      await onImport(chosen, setStatus);
      setChosen(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível importar o arquivo.');
    } finally {
      setStatus(null);
      if (input.current) input.current.value = '';
    }
  }

  const tooLarge = chosen !== null && chosen.size > MAX_ASSET_BYTES;

  return (
    <div className="flex flex-col gap-2" data-testid={testId} data-busy={busy}>
      <label
        htmlFor={inputId}
        onDragEnter={onDrag}
        onDragOver={onDrag}
        onDragLeave={onDrag}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-4 text-center text-sm transition-colors',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
          dragActive ? 'border-accent bg-surface-raised' : 'border-border-strong hover:border-accent',
          busy && 'cursor-progress opacity-70',
        )}
      >
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-muted">Arraste o arquivo ou clique para escolher · {AUDIO_FORMAT_LABEL}, até {megabytes(MAX_ASSET_BYTES)}</span>
        <input ref={input} id={inputId} type="file" accept={AUDIO_FILE_ACCEPT} className="sr-only" disabled={busy} onChange={(event) => choose(event.target.files?.[0])} />
      </label>

      {chosen && !busy && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="audio-chosen">
          <span className="min-w-0 flex-1 truncate">
            {chosen.name} · <span data-testid="audio-chosen-size">{megabytes(chosen.size)}</span>
          </span>
          <button type="button" className={buttonClass('primary', 'sm')} disabled={tooLarge} onClick={() => void confirm()}>
            Importar
          </button>
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => {
              setChosen(null);
              if (input.current) input.current.value = '';
            }}
          >
            Cancelar
          </button>
        </div>
      )}
      {tooLarge && !busy && (
        <p role="alert" className="text-xs text-danger">
          O arquivo passa do limite de {megabytes(MAX_ASSET_BYTES)} por faixa.
        </p>
      )}

      {status && (
        <div role="status" className="flex flex-col gap-1 text-xs" data-testid="audio-import-progress">
          <span>
            {status.label} {megabytes(status.loadedBytes)} de {megabytes(status.totalBytes)}
          </span>
          <progress className="h-1.5 w-full accent-accent" value={status.loadedBytes} max={Math.max(1, status.totalBytes)} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="audio-import-error">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}
