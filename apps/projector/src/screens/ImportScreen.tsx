'use client';

import type { HostEventPayload, ImportPreview, ImportRejection } from '@louvorvisual/contracts';
import type { Uuid } from '@louvorvisual/domain';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';
import { formatBytes, hostErrorText } from './shared';

const NEWER = 'Este pacote foi criado por uma versão mais nova do LouvorVisual. Atualize o aplicativo do projetor para importar.';
const BROKEN = 'O arquivo está corrompido ou foi alterado. Nada foi importado. Exporte o pacote de novo no computador.';

const REJECTION_TEXT: Record<ImportRejection, string> = {
  'not-a-package': 'O arquivo escolhido não é um pacote LouvorVisual (.louvorvisual.zip).',
  'too-large': 'O pacote passa do tamanho aceito. Exporte sem áudio ou só com a faixa escolhida de cada louvor.',
  'unsafe-path': BROKEN,
  'manifest-missing': 'O arquivo escolhido não é um pacote LouvorVisual (.louvorvisual.zip).',
  'manifest-invalid': BROKEN,
  'format-too-new': NEWER,
  'schema-too-new': NEWER,
  'schema-unsupported': 'Este pacote é de uma versão antiga que este aplicativo não sabe mais ler.',
  'font-pack-incompatible': 'O pacote pede outra versão das fontes. Atualize o aplicativo do projetor para importar.',
  'catalog-missing': 'O pacote usa um tema ou uma fonte que este aplicativo não tem. Atualize o aplicativo do projetor.',
  'unexpected-file': BROKEN,
  'missing-file': BROKEN,
  'hash-mismatch': BROKEN,
  'document-invalid': BROKEN,
  'reference-broken': BROKEN,
  unreadable: 'Não foi possível ler o arquivo. Confira se o pendrive continua conectado e tente de novo.',
  quota: 'Não há espaço neste aparelho para o pacote. Nada foi importado.',
};

const PHASE_TEXT: Record<HostEventPayload<'files.progress'>['phase'], string> = { copying: 'Copiando o arquivo para o aparelho', verifying: 'Conferindo o pacote', importing: 'Gravando' };

type Step =
  | { name: 'idle'; note: string | null }
  | { name: 'working'; progress: HostEventPayload<'files.progress'> | null }
  | { name: 'preview'; importId: string; fileName: string; preview: ImportPreview }
  | { name: 'rejected'; message: string }
  | { name: 'done'; setlistId: Uuid; title: string };

/**
 * Importar pacote: o host abre o seletor do sistema, copia e confere o
 * arquivo; a tela mostra o que entra antes de qualquer gravação e só então
 * confirma. Os bytes nunca passam pela interface.
 */
export function ImportScreen() {
  const app = useApp();
  const { host } = app;
  const [step, setStep] = useState<Step>({ name: 'idle', note: null });
  const pending = useRef<string | null>(null);

  useEffect(() => host.on('files.progress', (progress) => setStep((current) => (current.name === 'working' ? { name: 'working', progress } : current))), [host]);
  // Sair da tela com um pacote conferido e não confirmado: a cópia de preparação é descartada.
  useEffect(
    () => () => {
      if (pending.current) void host.request('files.discardImport', { importId: pending.current }).catch(() => undefined);
    },
    [host],
  );

  const discard = () => {
    if (!pending.current) return;
    void host.request('files.discardImport', { importId: pending.current }).catch(() => undefined);
    pending.current = null;
  };

  const pick = () => {
    setStep({ name: 'working', progress: null });
    host.request('files.pickPackage', {}).then(
      (result) => {
        if (result.status === 'cancelled') return setStep({ name: 'idle', note: 'Nenhum arquivo foi escolhido.' });
        if (result.status === 'rejected') return setStep({ name: 'rejected', message: REJECTION_TEXT[result.code] });
        pending.current = result.importId;
        setStep({ name: 'preview', importId: result.importId, fileName: result.fileName, preview: result.preview });
      },
      (error: unknown) => setStep({ name: 'rejected', message: hostErrorText(error) }),
    );
  };

  const apply = (importId: string, title: string) => {
    setStep({ name: 'working', progress: null });
    host.request('files.applyImport', { importId }).then(
      ({ setlistId }) => {
        pending.current = null;
        setStep({ name: 'done', setlistId, title });
      },
      (error: unknown) => {
        discard();
        setStep({ name: 'rejected', message: `${hostErrorText(error)} Nada foi importado.` });
      },
    );
  };

  const cancel = () => {
    discard();
    setStep({ name: 'idle', note: 'Importação cancelada. Nada foi gravado.' });
  };

  const ref = useFocusLayer<HTMLElement>({
    name: 'import',
    level: 0,
    repeat: 'directions',
    // Com o host trabalhando não há o que cancelar por aqui; a tela espera a resposta.
    onBack: () => (step.name === 'working' ? undefined : step.name === 'preview' ? cancel() : app.back()),
  });

  return (
    <main className="screen" ref={ref} data-layer="import" data-step={step.name}>
      <header className="screen-header">
        <h1>Importar pacote</h1>
        <p>.louvorvisual.zip</p>
      </header>

      {step.name === 'idle' && (
        <div className="panel">
          <h2>Trazer um repertório para este aparelho</h2>
          <p>Conecte o pendrive ou use um arquivo já baixado. O pacote é copiado para o aparelho e conferido antes de qualquer gravação; depois disso o pendrive pode ser retirado.</p>
          {step.note && <p data-testid="import-note">{step.note}</p>}
          <Action className="button" autoFocus testId="import-pick" onSelect={pick}>
            Escolher arquivo
          </Action>
        </div>
      )}

      {step.name === 'working' && (
        <div className="panel" data-testid="import-working">
          <h2>{step.progress ? PHASE_TEXT[step.progress.phase] : 'Aguardando o aparelho'}…</h2>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.progress && step.progress.totalBytes > 0 ? Math.round((step.progress.loadedBytes / step.progress.totalBytes) * 100) : 0}>
            <span style={{ width: `${step.progress && step.progress.totalBytes > 0 ? (step.progress.loadedBytes / step.progress.totalBytes) * 100 : 0}%` }} />
          </div>
          <p>Não retire o pendrive.</p>
        </div>
      )}

      {step.name === 'preview' && (
        <div className="panel" data-testid="import-preview">
          <h2>{step.preview.title}</h2>
          <p>
            {step.preview.songs} {step.preview.songs === 1 ? 'louvor' : 'louvores'} · {step.preview.mediaBytes > 0 ? `${formatBytes(step.preview.mediaBytes)} de áudio (${formatBytes(step.preview.newMediaBytes)} novos)` : 'sem áudio no pacote'}
          </p>
          {step.preview.newDocuments + step.preview.copiedDocuments === 0 ? (
            <p data-testid="import-nothing-new">Este repertório já estava importado. Nada será duplicado.</p>
          ) : (
            <p>
              Entram {step.preview.newDocuments + step.preview.copiedDocuments} itens novos
              {step.preview.existingDocuments > 0 ? `; ${step.preview.existingDocuments} já existem e ficam como estão` : ''}.
              {step.preview.copiedDocuments > 0 ? ` ${step.preview.copiedDocuments} entram como cópia “(importado)”: nada do que está neste aparelho é substituído.` : ''}
            </p>
          )}
          {step.preview.omittedMedia > 0 && (
            <p className="alert">
              {step.preview.omittedMedia} {step.preview.omittedMedia === 1 ? 'faixa de áudio não veio' : 'faixas de áudio não vieram'} no pacote; esses louvores podem ser apresentados sem áudio.
            </p>
          )}
          <Action className="button" autoFocus testId="import-apply" onSelect={() => apply(step.importId, step.preview.title)}>
            Importar
          </Action>
          <Action className="button" testId="import-cancel" onSelect={cancel}>
            Cancelar
          </Action>
        </div>
      )}

      {step.name === 'rejected' && (
        <div className="panel" data-testid="import-rejected">
          <h2>O pacote não foi importado</h2>
          <p className="alert" role="alert">
            {step.message}
          </p>
          <p>A biblioteca deste aparelho continua como estava.</p>
          <Action className="button" autoFocus testId="import-retry" onSelect={pick}>
            Escolher outro arquivo
          </Action>
          <Action className="button" onSelect={() => app.back()}>
            Voltar ao início
          </Action>
        </div>
      )}

      {step.name === 'done' && (
        <div className="panel" data-testid="import-done">
          <h2>“{step.title}” está neste aparelho</h2>
          <p>O pendrive já pode ser retirado.</p>
          <Action className="button" autoFocus testId="import-open" onSelect={() => app.replace({ name: 'setlist', setlistId: step.setlistId })}>
            Abrir o repertório
          </Action>
          <Action className="button" onSelect={() => app.back()}>
            Voltar ao início
          </Action>
        </div>
      )}

      <p className="hint">{step.name === 'working' ? 'Aguarde…' : 'Voltar cancela e retorna ao início'}</p>
    </main>
  );
}
