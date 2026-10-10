'use client';

import { useState } from 'react';
import { setLocalQuery } from '@/lib/localQuery';
import { discardMediaForDownload, repairDocument, scanIntegrity, useLocalSession, type DocumentProblem, type IntegrityReport, type MediaProblem } from '@/local';
import { LIBRARY_CHANGED_EVENT, syncEngine } from '@/sync/engine';

const TYPE_TEXT = { song: 'Louvor', arrangement: 'Arranjo', setlist: 'Repertório', asset: 'Arquivo de áudio', theme: 'Tema' } as const;

const REPAIR_TEXT: Record<DocumentProblem['repair'], string> = {
  server: 'Voltar à última versão confirmada pela equipe',
  history: 'Voltar à cópia válida mais recente do histórico',
  none: 'Retirar da biblioteca (o registro fica guardado)',
};

const MEDIA_TEXT: Record<MediaProblem['issue'], string> = {
  missing: 'o arquivo não está neste dispositivo',
  incomplete: 'a gravação do arquivo foi interrompida',
  corrupted: 'o arquivo guardado está diferente do original',
};

const REPAIRED_TEXT = {
  server: 'voltou à última versão confirmada pela equipe.',
  history: 'voltou à cópia válida mais recente do histórico e ficou pendente de envio.',
  removed: 'foi retirado da biblioteca; o registro ilegível continua guardado neste dispositivo.',
} as const;

/**
 * Conferência dos dados gravados: documentos contra o esquema e faixas contra
 * o hash. Só relata; cada conserto é uma ação explícita, e nada é apagado.
 */
export function IntegritySection({ buttonClassName }: { buttonClassName: string }) {
  const local = useLocalSession();
  const session = local.status === 'ready' ? local.session : null;
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function scan(verifyMedia: boolean) {
    if (!session) return;
    setMessage(null);
    setRunning({ done: 0, total: 0 });
    try {
      setReport(await scanIntegrity(session.db, { verifyMedia, now: new Date().toISOString(), onProgress: (done, total) => setRunning({ done, total }) }));
    } catch {
      setMessage('A conferência não terminou por um erro ao ler os dados. Nada foi alterado.');
    } finally {
      setRunning(null);
    }
  }

  async function repair(problem: DocumentProblem) {
    if (!session) return;
    try {
      const outcome = await repairDocument(session.db, problem.entityType, problem.entityId, new Date().toISOString());
      window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
      if (outcome === 'removed' && session.team) syncEngine(session).syncNow();
      setMessage(`${TYPE_TEXT[problem.entityType]} ${REPAIRED_TEXT[outcome]}`);
      await scan(false);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível consertar.');
    }
  }

  async function redownload(problem: MediaProblem) {
    if (!session) return;
    try {
      await discardMediaForDownload(session.db, problem.assetId);
      await syncEngine(session).downloadAssets([problem.assetId]);
      setMessage(`"${problem.filename}" foi baixado de novo e conferido.`);
      await scan(false);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível descartar o arquivo.');
    }
  }

  const documents = report?.problems.filter((problem): problem is DocumentProblem => problem.kind === 'document') ?? [];
  const media = report?.problems.filter((problem): problem is MediaProblem => problem.kind === 'media') ?? [];

  return (
    <section aria-labelledby="conferencia" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-6" data-testid="integrity">
      <h2 id="conferencia" className="text-lg font-bold">
        Conferência dos dados
      </h2>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonClassName} disabled={!session || running !== null} onClick={() => void scan(false)}>
          Conferir documentos
        </button>
        <button type="button" className={buttonClassName} disabled={!session || running !== null} onClick={() => void scan(true)}>
          Conferir também os áudios (lê cada arquivo)
        </button>
      </div>
      {running && (
        <p role="status" className="text-sm">
          Conferindo… {running.total > 0 ? `${running.done} de ${running.total} áudios` : ''}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm" data-testid="integrity-message">
          {message}
        </p>
      )}
      {report && !running && (
        <p role="status" data-testid="integrity-report" data-problems={report.problems.length} data-documents={report.documents} data-media={report.mediaFiles} data-media-verified={report.mediaVerified} className={report.problems.length > 0 ? 'font-semibold text-danger' : undefined}>
          {report.problems.length === 0
            ? `Tudo certo: ${report.documents} documentos legíveis e ${report.mediaFiles} ${report.mediaFiles === 1 ? 'áudio presente' : 'áudios presentes'}${report.mediaVerified ? ', com os bytes conferidos' : ' (bytes não relidos nesta conferência)'}.`
            : `${report.problems.length} ${report.problems.length === 1 ? 'problema encontrado' : 'problemas encontrados'} em ${report.documents} documentos e ${report.mediaFiles} áudios.`}
        </p>
      )}
      {documents.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm" aria-label="Documentos ilegíveis">
          {documents.map((problem) => (
            <li key={`${problem.entityType}:${problem.entityId}`} className="flex flex-wrap items-center justify-between gap-3" data-testid="integrity-document" data-repair={problem.repair}>
              <span>
                {TYPE_TEXT[problem.entityType]} ilegível ({problem.title}).
              </span>
              <button type="button" className={buttonClassName} onClick={() => void repair(problem)}>
                {REPAIR_TEXT[problem.repair]}
              </button>
            </li>
          ))}
        </ul>
      )}
      {media.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm" aria-label="Áudios com problema">
          {media.map((problem) => (
            <li key={problem.assetId} className="flex flex-wrap items-center justify-between gap-3" data-testid="integrity-media" data-issue={problem.issue} data-repair={problem.repair}>
              <span>
                {problem.filename}: {MEDIA_TEXT[problem.issue]}. Usado em {problem.songTitles.join(', ')}.
              </span>
              {problem.repair === 'download' ? (
                <button type="button" className={buttonClassName} onClick={() => void redownload(problem)}>
                  Baixar de novo da equipe
                </button>
              ) : (
                <button type="button" className={buttonClassName} onClick={() => setLocalQuery({ view: 'biblioteca' })}>
                  Abrir a biblioteca para importar o áudio de novo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
