'use client';

import { documentSchemas } from '@louvorvisual/contracts';
import { reparseLyrics, touch, type Arrangement, type Asset, type Setlist, type Song } from '@louvorvisual/domain';
import { ConflictResolutionError, resolveAlternative, resolveKeepLocal, resolveKeepRemote, type ConflictRecord, type SyncDoc, type SyncEntityType } from '@louvorvisual/sync';
import { useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import type { LocalSession } from '@/local/session';
import { alternativeBuilder } from '@/sync/alternatives';
import { accountApi } from '@/sync/api';
import type { SyncEngine } from '@/sync/engine';
import { downloadJson } from '@/sync/exportPending';
import { CONFLICT_TEXT, dateTime, ENTITY_TEXT } from './labels';

type Field = { label: string; value: string };

function seconds(durationMs: number | null): string {
  return durationMs === null ? 'sem tempo' : `${(durationMs / 1000).toLocaleString('pt-BR')} s`;
}

/** Conteúdo de um documento em campos legíveis, para comparar as duas variantes lado a lado. */
function describe(entityType: SyncEntityType, document: SyncDoc, arrangementNames: Map<string, string>): Field[] {
  const fields: Field[] = [];
  if (entityType === 'song') {
    const song = document as Song;
    fields.push({ label: 'Título', value: song.title }, { label: 'Artista', value: song.artist ?? '—' }, { label: 'Tom', value: song.musicalKey ?? '—' }, { label: 'Etiquetas', value: song.tags.join(', ') || '—' }, { label: 'Letra', value: song.rawLyrics });
  } else if (entityType === 'arrangement') {
    const arrangement = document as Arrangement;
    const slides = [...arrangement.occurrences].sort((a, b) => a.order - b.order);
    fields.push(
      { label: 'Nome', value: arrangement.name },
      { label: 'Modo', value: arrangement.defaultMode === 'automatic' ? 'Automático' : 'Manual' },
      { label: `Slides (${slides.length})`, value: slides.map((slide, index) => `${index + 1}. ${slide.label} · ${seconds(slide.durationMs)}\n${slide.text}`).join('\n\n') },
      { label: 'Faixas de áudio', value: String(arrangement.audioBindings.length) },
    );
  } else if (entityType === 'setlist') {
    const setlist = document as Setlist;
    const items = [...setlist.items].sort((a, b) => a.order - b.order);
    fields.push(
      { label: 'Título', value: setlist.title },
      { label: 'Data do culto', value: setlist.serviceDate ?? 'Sem data' },
      { label: `Itens (${items.length})`, value: items.map((item, index) => `${index + 1}. ${arrangementNames.get(item.arrangementId) ?? item.arrangementId}${item.notes ? ` — ${item.notes}` : ''}`).join('\n') || '—' },
      { label: 'Notas', value: setlist.notes || '—' },
    );
  } else {
    const asset = document as Asset;
    fields.push({ label: 'Arquivo', value: asset.filename ?? document.id });
  }
  fields.push({ label: 'Situação', value: document.deletedAt === null ? 'Ativo' : 'Excluído' });
  return fields;
}

function Variant({ title, testId, fields, other }: { title: string; testId: string; fields: Field[]; other: Field[] }) {
  return (
    <section aria-label={title} data-testid={testId} className="min-w-0 rounded-lg border border-border p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase text-muted">{title}</h3>
      <dl className="flex flex-col gap-3 text-sm">
        {fields.map((field, index) => {
          const differs = other[index]?.value !== field.value;
          return (
            <div key={field.label} data-field={field.label} data-differs={differs} className={differs ? 'border-l-2 border-accent pl-3' : 'pl-3'}>
              <dt className="text-xs font-semibold text-muted">
                {field.label}
                {differs && <span className="ml-2 text-accent">diferente</span>}
              </dt>
              <dd className="whitespace-pre-wrap break-words">{field.value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

type Props = { session: LocalSession; engine: SyncEngine; conflict: ConflictRecord; onDone: (message: string) => void };

/**
 * Tela de conflito (planejamento/09): título, autor da alteração remota,
 * revisão local, remota e base conhecida, o conteúdo das duas variantes e as
 * quatro saídas. Nenhuma delas descarta uma variante sem deixá-la recuperável.
 */
export function ConflictPanel({ session, engine, conflict, onDone }: Props) {
  const [local, setLocal] = useState<SyncDoc>(conflict.local);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [author, setAuthor] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ title: string; artist: string; rawLyrics: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { db, team } = session;
  const remote = conflict.remote;
  const remoteAuthorId = 'updatedBy' in remote ? remote.updatedBy : null;
  const ownChange = team !== null && remoteAuthorId === team.userId;

  // A variante local é o documento vivo: pode ter recebido edições depois da detecção.
  useEffect(() => {
    let current = true;
    void engine.storage
      .transaction(async (tx) => ({ document: await tx.getDocument(conflict.entityType, conflict.entityId), arrangements: await tx.listDocuments('arrangement') }))
      .then(({ document, arrangements }) => {
        if (!current) return;
        if (document) setLocal(document);
        setNames(new Map(arrangements.map((arrangement) => [arrangement.id, (arrangement as Arrangement).name])));
      });
    return () => {
      current = false;
    };
  }, [engine, conflict]);

  useEffect(() => {
    let current = true;
    if (!team || !remoteAuthorId || remoteAuthorId === team.userId) return;
    // Nome do autor é informação online; sem conexão, mostra-se o identificador.
    accountApi.members(team.workspaceId).then(
      (members) => current && setAuthor(members.find((member) => member.userId === remoteAuthorId)?.user.name ?? null),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [team, remoteAuthorId]);

  const deps = { storage: engine.storage, now: () => new Date().toISOString() };
  const title = String(('title' in local && local.title) || ('name' in local && local.name) || conflict.entityId);
  const localFields = describe(conflict.entityType, local, names);
  const remoteFields = describe(conflict.entityType, remote, names);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      engine.announceLibraryChange();
      engine.syncNow();
      onDone(message);
    } catch (reason) {
      setError(reason instanceof ConflictResolutionError ? reason.message : 'Não foi possível concluir. Nada foi alterado.');
    } finally {
      setBusy(false);
    }
  }

  async function saveMerged() {
    if (!merging) return;
    const source = local as Song;
    const context = session.context();
    const merged = touch({ ...source, title: merging.title.trim(), artist: merging.artist.trim() || null, rawLyrics: merging.rawLyrics, sections: reparseLyrics(merging.rawLyrics, source.sections, context.newId).sections, deletedAt: null }, context);
    const checked = documentSchemas.song.safeParse(merged);
    if (!checked.success) {
      setError('A versão combinada não passou na validação: confira o título e a letra.');
      return;
    }
    await run(() => resolveKeepLocal(deps, conflict.id, merged as SyncDoc), 'Versão combinada salva. Ela será enviada como nova revisão.');
  }

  const remoteDeleted = conflict.kind === 'remote-deleted';

  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border-strong bg-surface-raised p-5" data-testid="conflict-panel" data-kind={conflict.kind} data-entity-type={conflict.entityType} data-entity-id={conflict.entityId}>
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">
          Conflito em {ENTITY_TEXT[conflict.entityType].toLowerCase()}: {title}
        </h2>
        <p>{CONFLICT_TEXT[conflict.kind]}</p>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="conflict-revisions" data-base={conflict.baseRevision ?? ''} data-remote={conflict.remoteRevision} data-local-generation={conflict.localGeneration}>
          <div>
            <dt className="inline text-muted">Base conhecida: </dt>
            <dd className="inline">{conflict.baseRevision ? `revisão ${conflict.baseRevision}` : 'nunca confirmada'}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Versão remota: </dt>
            <dd className="inline">revisão {conflict.remoteRevision}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Minha versão: </dt>
            <dd className="inline">geração local {conflict.localGeneration}, ainda não enviada</dd>
          </div>
          <div>
            <dt className="inline text-muted">Alteração remota por: </dt>
            <dd className="inline" data-testid="conflict-author">
              {ownChange ? `${team?.userName} (você, em outro dispositivo)` : (author ?? (remoteAuthorId ? `membro ${remoteAuthorId.slice(0, 8)}` : 'desconhecido'))}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted">Remota em: </dt>
            <dd className="inline">{dateTime.format(new Date(remote.updatedAt))}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Local em: </dt>
            <dd className="inline">{dateTime.format(new Date(local.updatedAt))}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">As datas ajudam a leitura, mas não decidem qual versão vale: a escolha é sua.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Variant title="Minha versão (neste dispositivo)" testId="conflict-local" fields={localFields} other={remoteFields} />
        <Variant title={remoteDeleted ? 'Versão remota (excluída)' : 'Versão remota (da equipe)'} testId="conflict-remote" fields={remoteFields} other={localFields} />
      </div>

      {merging ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-accent p-4"
          data-testid="conflict-merge"
          onSubmit={(event) => {
            event.preventDefault();
            void saveMerged();
          }}
        >
          <h3 className="font-semibold">Combinar: edite o resultado</h3>
          <p className="text-sm text-muted">Começa com a sua versão. Copie o que quiser da versão remota, mostrada acima, e salve a versão revisada.</p>
          <div>
            <Label htmlFor="merge-title">Título</Label>
            <Input id="merge-title" value={merging.title} onChange={(event) => setMerging({ ...merging, title: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="merge-artist">Artista</Label>
            <Input id="merge-artist" value={merging.artist} onChange={(event) => setMerging({ ...merging, artist: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="merge-lyrics">Letra</Label>
            <Textarea id="merge-lyrics" rows={12} value={merging.rawLyrics} onChange={(event) => setMerging({ ...merging, rawLyrics: event.target.value })} />
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={buttonClass('primary')} disabled={busy}>
              Salvar versão combinada
            </button>
            <button type="button" className={buttonClass('secondary')} onClick={() => setMerging(null)}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3" data-testid="conflict-actions">
          <div className="flex flex-wrap gap-3">
            <button type="button" className={buttonClass('secondary')} disabled={busy} data-action="keep-remote" onClick={() => void run(() => resolveKeepRemote(deps, conflict.id), remoteDeleted ? 'A exclusão foi aceita. A sua versão ficou arquivada neste dispositivo.' : 'Versão remota adotada. A sua versão ficou arquivada neste dispositivo.')}>
              {remoteDeleted ? 'Aceitar a exclusão' : 'Manter remoto'}
            </button>
            {!remoteDeleted && (
              <button type="button" className={buttonClass('secondary')} disabled={busy} data-action="keep-local" onClick={() => void run(() => resolveKeepLocal(deps, conflict.id), 'A sua versão será enviada como nova revisão, sobre a versão remota atual.')}>
                {conflict.kind === 'local-deleted' ? 'Manter a minha exclusão' : 'Manter minha versão'}
              </button>
            )}
            {conflict.entityType === 'song' && conflict.kind === 'both-edited' && (
              <button type="button" className={buttonClass('secondary')} disabled={busy} data-action="merge" onClick={() => setMerging({ title: (local as Song).title, artist: (local as Song).artist ?? '', rawLyrics: (local as Song).rawLyrics })}>
                Combinar
              </button>
            )}
            {conflict.entityType !== 'asset' && conflict.kind !== 'local-deleted' && (
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={busy}
                data-action="alternative"
                onClick={() => void run(async () => resolveAlternative(deps, conflict.id, await alternativeBuilder(db, conflict, session.context())), 'A sua versão virou um registro novo, com "(minha versão)" no nome. O original ficou com a versão remota.')}
              >
                {remoteDeleted ? 'Restaurar como novo registro' : 'Criar alternativa'}
              </button>
            )}
            <button type="button" className={buttonClass('secondary')} data-action="export" onClick={() => downloadJson(`louvorvisual-minha-versao-${conflict.entityId}.json`, { entityType: conflict.entityType, document: local })}>
              Exportar minha versão
            </button>
          </div>
          <ul className="list-disc pl-5 text-xs text-muted">
            <li>{remoteDeleted ? 'Aceitar a exclusão' : 'Manter remoto'}: arquiva a sua versão neste dispositivo e adota a remota.</li>
            {!remoteDeleted && <li>Manter minha versão: arquiva a remota e envia a sua como nova revisão. Se alguém alterar de novo antes do envio, o conflito reabre.</li>}
            {remoteDeleted && <li>Um registro excluído não volta por um envio antigo: para continuar com a sua edição, restaure-a como um novo registro.</li>}
            {conflict.entityType === 'arrangement' && <li>Slides e tempos não são combinados automaticamente: crie uma alternativa e ajuste no editor.</li>}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
