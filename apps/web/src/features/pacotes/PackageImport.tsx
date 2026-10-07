'use client';

import { PackageError } from '@louvorvisual/pack';
import { useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { freeSpaceEstimate } from '@/lib/download';
import { setLocalQuery } from '@/lib/localQuery';
import { applyImport, ImportFailure, previewImport, QUOTA_MARGIN_BYTES, type ImportContext, type ImportPreview, type ImportResult, type LocalSession } from '@/local';
import { formatBytes } from '../audio/htmlTransport';

type Stage =
  | { step: 'idle' }
  | { step: 'checking'; loaded: number; total: number }
  | { step: 'preview'; preview: ImportPreview; free: number | null }
  | { step: 'applying' }
  | { step: 'done'; result: ImportResult }
  | { step: 'error'; code: string; message: string };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Importação de um pacote `.louvorvisual.zip`. O arquivo é conferido por
 * inteiro antes de qualquer gravação e a tela mostra o que vai acontecer;
 * nada do que já existe na biblioteca é substituído.
 */
export function PackageImport({ session, onImported }: { session: LocalSession; onImported: () => void }) {
  const [stage, setStage] = useState<Stage>({ step: 'idle' });
  const input = useRef<HTMLInputElement>(null);

  const context = (): ImportContext => {
    const authoring = session.context();
    return { workspaceId: authoring.workspaceId, userId: authoring.userId, profileId: session.profile.profileId, now: authoring.now, newId: authoring.newId };
  };

  const fail = (reason: unknown) =>
    setStage(
      reason instanceof PackageError || reason instanceof ImportFailure
        ? { step: 'error', code: reason.code, message: reason.message }
        : { step: 'error', code: 'unknown', message: 'Não foi possível ler o arquivo. Nada foi importado.' },
    );

  async function choose(file: File) {
    setStage({ step: 'checking', loaded: 0, total: file.size });
    try {
      const preview = await previewImport(session.db, file, context(), { onProgress: (loaded, total) => setStage({ step: 'checking', loaded, total }) });
      setStage({ step: 'preview', preview, free: await freeSpaceEstimate() });
    } catch (reason) {
      fail(reason);
    }
  }

  async function confirm(preview: ImportPreview) {
    setStage({ step: 'applying' });
    try {
      const result = await applyImport(session.db, preview.opened, context(), { freeSpace: freeSpaceEstimate });
      setStage({ step: 'done', result });
      onImported();
    } catch (reason) {
      fail(reason);
    }
  }

  function reset() {
    if (input.current) input.current.value = '';
    setStage({ step: 'idle' });
  }

  const busy = stage.step === 'checking' || stage.step === 'applying';

  return (
    <section aria-labelledby="importar-pacote" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4 shadow-card sm:p-5" data-testid="package-import" data-step={stage.step}>
      <h2 id="importar-pacote" className="text-lg font-bold">
        Importar pacote
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="pacote-arquivo" className="text-sm">
          Arquivo <code>.louvorvisual.zip</code> exportado pelo LouvorVisual
        </label>
        <input
          ref={input}
          id="pacote-arquivo"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          className="text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
          }}
        />
      </div>

      {stage.step === 'checking' && (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <span>
            Conferindo o pacote: {formatBytes(stage.loaded)} de {formatBytes(stage.total)}. Nada é gravado nesta etapa.
          </span>
          <progress className="h-1.5 w-full accent-accent" value={stage.loaded} max={Math.max(1, stage.total)} />
        </div>
      )}

      {stage.step === 'preview' && (
        <Preview preview={stage.preview} free={stage.free} team={session.team ? { name: session.team.workspaceName, canPublish: session.team.role !== 'operator' } : null} onConfirm={() => void confirm(stage.preview)} onCancel={reset} />
      )}

      {stage.step === 'applying' && <p role="status">Gravando o repertório e conferindo os áudios…</p>}

      {stage.step === 'done' && (
        <div role="status" className="flex flex-wrap items-center gap-3 text-sm" data-testid="import-result" data-setlist-id={stage.result.setlistId} data-written={stage.result.plan.writes.length} data-media-stored={stage.result.mediaStored}>
          <p className="min-w-0 flex-1">
            {stage.result.plan.writes.length === 0 && stage.result.mediaStored === 0
              ? 'Este pacote já estava importado: nada precisou ser gravado.'
              : `Importação concluída: ${plural(stage.result.plan.writes.length, 'documento gravado', 'documentos gravados')} e ${plural(stage.result.mediaStored, 'áudio guardado', 'áudios guardados')}.`}{' '}
            Abra o repertório e use &ldquo;Preparar para uso offline&rdquo; antes de apresentar.
          </p>
          <button type="button" className={buttonClass('primary', 'sm')} onClick={() => setLocalQuery({ view: 'repertorios', repertorio: stage.result.setlistId })}>
            Abrir o repertório
          </button>
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={reset}>
            Fechar
          </button>
        </div>
      )}

      {stage.step === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger" data-testid="import-error" data-code={stage.code}>
          <p className="min-w-0 flex-1">
            {stage.message} A biblioteca deste dispositivo não foi alterada.
          </p>
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={reset}>
            Escolher outro arquivo
          </button>
        </div>
      )}
    </section>
  );
}

type PreviewProps = { preview: ImportPreview; free: number | null; team: { name: string; canPublish: boolean } | null; onConfirm: () => void; onCancel: () => void };

function Preview({ preview, free, team, onConfirm, onCancel }: PreviewProps) {
  const { opened, plan, newMediaBytes } = preview;
  const { manifest } = opened;
  const incoming = plan.counts.insert + plan.counts.copy;
  const missingAudio = manifest.omittedMedia.length;
  const noSpace = free !== null && newMediaBytes > 0 && free < newMediaBytes + QUOTA_MARGIN_BYTES;
  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="import-preview"
      data-same-workspace={plan.sameWorkspace}
      data-insert={plan.counts.insert}
      data-copy={plan.counts.copy}
      data-reuse={plan.counts.reuse}
      data-diverged={plan.diverged}
      data-new-media-bytes={newMediaBytes}
    >
      <p>
        Repertório <strong>{manifest.scope.title}</strong>, exportado em {new Date(manifest.createdAt).toLocaleString('pt-BR')}{' '}
        {plan.sameWorkspace ? 'desta mesma biblioteca.' : 'de outra biblioteca: entra aqui como cópia, com identificadores novos.'} O arquivo foi conferido e está íntegro.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          {incoming === 0
            ? 'Nenhum documento novo: tudo o que o pacote traz já está aqui, igual.'
            : `${plural(incoming, 'documento entra', 'documentos entram')} na biblioteca${plan.counts.reuse > 0 ? `; ${plural(plan.counts.reuse, 'já existe igual e não muda', 'já existem iguais e não mudam')}` : ''}.`}
        </li>
        {plan.diverged > 0 && (
          <li data-testid="import-diverged">
            O que está aqui é diferente do pacote em {plural(plan.diverged, 'item', 'itens')}. Nada é substituído: o conteúdo do pacote entra como cópia, com &ldquo;(importado)&rdquo; no nome.
          </li>
        )}
        <li>
          Áudio: {formatBytes(plan.mediaBytes)} no pacote, {formatBytes(newMediaBytes)} a guardar neste dispositivo
          {free !== null ? ` (${formatBytes(free)} livres)` : ''}.
        </li>
        {missingAudio > 0 && (
          <li data-testid="import-missing-audio">
            {plural(missingAudio, 'faixa não veio', 'faixas não vieram')} no pacote. Os louvores entram mesmo assim; o áudio precisará ser importado no editor.
          </li>
        )}
      </ul>
      {team && incoming > 0 && (
        <p data-testid="import-team-note">
          {team.canPublish
            ? `O que entrar será publicado para a equipe ${team.name} na próxima sincronização, como conteúdo novo.`
            : `Seu papel na equipe ${team.name} não permite publicar: o que entrar fica só neste dispositivo, como pendência, até alguém com permissão de edição importar o pacote.`}
        </p>
      )}
      {noSpace && (
        <p role="alert" className="font-semibold text-danger">
          Não há espaço suficiente neste dispositivo para os áudios do pacote. Libere espaço em &ldquo;Disponível offline&rdquo; antes de importar.
        </p>
      )}
      <div className="flex gap-3">
        <button type="button" className={buttonClass('primary')} disabled={noSpace} onClick={onConfirm}>
          Importar
        </button>
        <button type="button" className={buttonClass('secondary')} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
