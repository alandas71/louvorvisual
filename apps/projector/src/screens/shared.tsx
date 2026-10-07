'use client';

import type { SongSummary } from '@louvorvisual/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HostError } from '@/host/client';

export const PAGE_SIZE = 20;

type Page<T> = { items: T[]; nextCursor: string | null };
export type PagedState<T> = { items: T[]; status: 'loading' | 'idle' | 'done' | 'error'; error: string | null };

/**
 * Lista paginada vinda do host: a tela guarda só as páginas já pedidas, e pede
 * a seguinte quando o foco chega perto do fim (planejamento/21: nada de montar
 * a biblioteca inteira na memória do WebView).
 */
export function usePaged<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>): PagedState<T> & { more(): void } {
  const [state, setState] = useState<PagedState<T>>({ items: [], status: 'loading', error: null });
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const done = useRef(false);
  const fetcher = useRef(fetchPage);
  useEffect(() => {
    fetcher.current = fetchPage;
  });

  const more = useCallback(() => {
    if (busy.current || done.current) return;
    busy.current = true;
    fetcher.current(cursor.current).then(
      (page) => {
        busy.current = false;
        cursor.current = page.nextCursor;
        done.current = page.nextCursor === null;
        setState((previous) => ({ items: [...previous.items, ...page.items], status: done.current ? 'done' : 'idle', error: null }));
      },
      (error: unknown) => {
        busy.current = false;
        setState((previous) => ({ ...previous, status: 'error', error: hostErrorText(error) }));
      },
    );
  }, []);

  useEffect(() => {
    more();
  }, [more]);

  return { ...state, more };
}

export function hostErrorText(error: unknown): string {
  const code = error instanceof HostError ? error.code : 'failed';
  if (code === 'not-found') return 'Este conteúdo não está mais neste aparelho.';
  if (code === 'timeout') return 'O aplicativo demorou para responder. Tente de novo.';
  if (code === 'quota') return 'Não há espaço neste aparelho.';
  return 'Não foi possível ler os dados deste aparelho. Tente de novo.';
}

const AUDIO_TAG: Record<SongSummary['audio'], { text: string; className: string } | null> = {
  none: null,
  ready: { text: 'Áudio pronto', className: 'tag tag-ok' },
  missing: { text: 'Áudio ausente', className: 'tag tag-warn' },
};

export function SongMeta({ song }: { song: SongSummary }) {
  const audio = AUDIO_TAG[song.audio];
  return (
    <span className="row-meta">
      {song.slideCount} {song.slideCount === 1 ? 'slide' : 'slides'}
      {audio && (
        <>
          {' · '}
          <span className={audio.className}>{audio.text}</span>
        </>
      )}
    </span>
  );
}

export function formatDate(date: string | null): string {
  if (!date) return 'Sem data';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}
