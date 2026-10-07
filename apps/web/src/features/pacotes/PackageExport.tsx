'use client';

import type { MediaPolicy, PackageManifest } from '@louvorvisual/pack';
import { PackageError } from '@louvorvisual/pack';
import { useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { downloadBlob } from '@/lib/download';
import { estimateSetlistPackage, exportSetlistPackage, type LocalSession, type PackageEstimate } from '@/local';
import { formatBytes } from '../audio/htmlTransport';

const POLICY_TEXT: Record<MediaPolicy, string> = {
  all: 'Todas as faixas dos louvores',
  selected: 'Só a faixa escolhida de cada louvor',
  none: 'Sem áudio (somente letras, slides e tempos)',
};

type Done = { filename: string; bytes: number; manifest: PackageManifest };

/**
 * Exportação do repertório como pacote `.louvorvisual.zip`: documentos,
 * manifesto com hashes e, conforme a escolha, os arquivos de áudio. Nenhuma
 * credencial entra no arquivo.
 */
export function PackageExport({ session, setlistId, refreshKey }: { session: LocalSession; setlistId: string; refreshKey: unknown }) {
  const [estimate, setEstimate] = useState<PackageEstimate | null>(null);
  const [policy, setPolicy] = useState<MediaPolicy>('all');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    estimateSetlistPackage(session.db, setlistId).then(
      (next) => current && setEstimate(next),
      () => current && setEstimate(null),
    );
    return () => {
      current = false;
    };
  }, [session, setlistId, refreshKey]);

  async function run() {
    setError(null);
    setDone(null);
    setProgress({ loaded: 0, total: estimate?.mediaBytes[policy] ?? 0 });
    try {
      const built = await exportSetlistPackage(session.db, setlistId, {
        mediaPolicy: policy,
        profileKind: session.team ? 'team' : 'personal',
        now: new Date().toISOString(),
        newId: () => crypto.randomUUID(),
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      });
      downloadBlob(built.filename, built.file);
      setDone({ filename: built.filename, bytes: built.file.size, manifest: built.manifest });
    } catch (reason) {
      setError(reason instanceof PackageError ? reason.message : 'Não foi possível montar o pacote neste dispositivo. Nada foi alterado.');
    } finally {
      setProgress(null);
    }
  }

  const unavailable = done?.manifest.omittedMedia.filter((item) => item.reason === 'unavailable') ?? [];
  const media = done?.manifest.entries.filter((entry) => entry.kind === 'media').length ?? 0;

  return (
    <section aria-labelledby="pacote" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-5" data-testid="package-export">
      <h2 id="pacote" className="text-lg font-semibold">
        Pacote de segurança
      </h2>
      <p className="text-sm text-muted">
        Um arquivo <code>.louvorvisual.zip</code> com este repertório: louvores, slides, tempos e, se você quiser, os áudios. Serve para guardar uma cópia fora do navegador e para levar o
        repertório a outro computador ou ao projetor. Senhas e dados de acesso nunca entram no arquivo.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64">
          <Label htmlFor="pacote-audio">Áudio no pacote</Label>
          <Select id="pacote-audio" value={policy} onChange={(event) => setPolicy(event.target.value as MediaPolicy)}>
            {(Object.keys(POLICY_TEXT) as MediaPolicy[]).map((option) => (
              <option key={option} value={option}>
                {POLICY_TEXT[option]}
                {estimate ? ` — ${formatBytes(estimate.mediaBytes[option])}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <button type="button" className={buttonClass('secondary')} disabled={progress !== null} onClick={() => void run()}>
          Exportar pacote
        </button>
      </div>
      {progress && (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <span>
            Lendo e conferindo os áudios: {formatBytes(progress.loaded)} de {formatBytes(progress.total)}
          </span>
          <progress className="h-1.5 w-full accent-accent" value={progress.loaded} max={Math.max(1, progress.total)} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="package-export-error">
          {error}
        </p>
      )}
      {done && (
        <div role="status" className="flex flex-col gap-1 text-sm" data-testid="package-export-result" data-filename={done.filename} data-bytes={done.bytes} data-media={media} data-unavailable={unavailable.length}>
          <p>
            Pacote <strong>{done.filename}</strong> gerado ({formatBytes(done.bytes)}): {done.manifest.entries.length - media} documentos e {media}{' '}
            {media === 1 ? 'arquivo de áudio' : 'arquivos de áudio'}. O navegador o salvou na pasta de downloads.
          </p>
          {unavailable.length > 0 && (
            <p className="font-semibold text-danger">
              ⚠ {unavailable.length} {unavailable.length === 1 ? 'faixa não entrou' : 'faixas não entraram'} no pacote: o arquivo não está neste dispositivo ou está diferente do original. Importe o
              áudio de novo no editor do louvor e exporte outra vez.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
