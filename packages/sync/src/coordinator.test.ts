import { describe, expect, it } from 'vitest';
import { formBatches, UPLOAD_CHUNK_BYTES } from './coordinator';
import { listPending, summarize } from './inspect';
import { adoptDeferredRemote, ConflictResolutionError, resolveAlternative, resolveKeepLocal, resolveKeepRemote } from './resolve';
import { device, FakeServer, fixtures, songDoc, titled, titleOf, USER, type Device } from './testing';
import { entityKey, type AssetDoc, type QueuedOperation, type SyncDoc } from './types';

const { song, arrangement, asset, setlist } = fixtures;
const withoutAudio = { ...arrangement, audioBindings: [], selectedAudioBindingId: null } as SyncDoc;

/** A e B já sincronizados com o louvor de teste na revisão 1. */
async function pair() {
  const server = new FakeServer();
  const a = device(server, 'a');
  const b = device(server, 'b');
  await a.save('song', song);
  await a.sync();
  await b.sync();
  return { server, a, b };
}

const resolver = (d: Device) => ({ storage: d.storage, now: d.now });

describe('fila local e captura imutável', () => {
  it('cria offline, reconecta e converge no segundo dispositivo sem IDs duplicados', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    const b = device(server, 'b');
    a.transport.faults.offline = true;
    await a.save('song', song);
    expect(await a.sync()).toMatchObject({ connection: 'offline', retry: true });
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 1, serverRevision: null, localGeneration: 1 });

    a.transport.faults.offline = false;
    expect(await a.sync()).toMatchObject({ connection: 'idle', pushed: 1 });
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '1' });

    expect(await b.sync()).toMatchObject({ connection: 'idle', bootstrapped: true });
    expect(titleOf(await b.doc('song', song.id))).toBe('Manhã de Gratidão');
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '1', localGeneration: 0 });
    expect(server.eventsFor(song.id)).toHaveLength(1);
    // Novo ciclo nos dois lados: nada a enviar, nada a receber.
    expect(await a.sync()).toMatchObject({ pushed: 0, adopted: 0 });
    expect(await b.sync()).toMatchObject({ pushed: 0, adopted: 0 });
    expect(server.events).toHaveLength(1);
  });

  it('condensa edições que nunca saíram do dispositivo em uma única tentativa', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    a.transport.faults.offline = true;
    await a.save('song', song);
    await a.save('song', titled(song, 'Segunda'));
    await a.save('song', titled(song, 'Terceira'));
    a.transport.faults.offline = false;
    await a.sync();
    expect(server.pushLog).toHaveLength(1);
    expect(titleOf(server.pushLog[0]!.operations[0]!.payload)).toBe('Terceira');
    expect(server.revisionOf('song', song.id)).toBe('1');
  });

  it('repete a tentativa com o mesmo opId e o mesmo payload, mesmo com edição mais nova', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    a.transport.faults.pushStatus = { status: 503, code: 'SERVICE_UNAVAILABLE' };
    expect(await a.sync()).toMatchObject({ connection: 'error', retry: true });
    const [captured] = (await a.operations()) as [QueuedOperation];
    expect(captured).toMatchObject({ attempts: 1, capturedGeneration: 1, status: 'queued', lastError: 'SERVICE_UNAVAILABLE' });
    expect(captured.firstSentAt).not.toBeNull();

    await a.save('song', titled(song, 'Geração 2'));
    a.transport.faults.pushStatus = null;
    await a.sync();

    // Primeiro envio aceito: exatamente a tentativa persistida, sem o texto novo.
    expect(server.pushLog[0]!.operations[0]).toMatchObject({ opId: captured.opId, action: 'create', baseRevision: '0' });
    expect(server.pushLog[0]!.operations[0]!.payload).toEqual(captured.payload);
    // A geração 2 saiu depois, como outra tentativa sobre a revisão confirmada.
    expect(server.pushLog[1]!.operations[0]).toMatchObject({ action: 'update', baseRevision: '1' });
    expect(server.pushLog[1]!.operations[0]!.opId).not.toBe(captured.opId);
    expect(titleOf(server.documentOf('song', song.id))).toBe('Geração 2');
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2', localGeneration: 2 });
  });

  it('ack antigo atualiza a base, mas nunca substitui nem dá como enviada a geração mais nova', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    // O usuário continua editando enquanto a geração 1 está em trânsito.
    a.transport.faults.beforePush = async () => {
      a.transport.faults.beforePush = null;
      await a.save('song', titled(song, 'Geração 2, ainda local'));
    };
    a.transport.faults.pushStatus = null;
    // Sem novo ciclo de captura: observar o estado logo após a confirmação da geração 1.
    const pushes: number[] = [];
    a.storage.onCommit = () => pushes.push(server.pushLog.length);
    await a.sync();
    a.storage.onCommit = null;

    expect(titleOf(server.pushLog[0]!.operations[0]!.payload)).toBe('Manhã de Gratidão');
    expect(titleOf(await a.doc('song', song.id))).toBe('Geração 2, ainda local');
    // O ciclo seguinte de captura, dentro do mesmo sync, enviou a geração 2 sobre a revisão 1.
    expect(server.pushLog[1]!.operations[0]).toMatchObject({ action: 'update', baseRevision: '1' });
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2', localGeneration: 2 });
    expect(titleOf(server.documentOf('song', song.id))).toBe('Geração 2, ainda local');
  });

  it('ack da geração capturada não limpa a pendência quando há geração mais nova (estado intermediário)', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    let intermediate: Awaited<ReturnType<Device['stateOf']>>;
    a.transport.faults.beforePush = async (operations) => {
      if (operations[0]!.action === 'create') await a.save('song', titled(song, 'Mais nova'));
      else intermediate = await a.stateOf('song', song.id);
    };
    await a.sync();
    expect(intermediate!).toMatchObject({ serverRevision: '1', dirty: 1, localGeneration: 2 });
    expect(titleOf(intermediate!.lastAckSnapshot ?? undefined)).toBe('Manhã de Gratidão');
  });

  it('AT-12: resposta perdida após o commit não cria outro registro nem outra revisão', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    a.transport.faults.loseResponses = 1;
    expect(await a.sync()).toMatchObject({ connection: 'offline', retry: true });
    expect(server.revisionOf('song', song.id)).toBe('1');
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 1, serverRevision: null });
    const [kept] = (await a.operations()) as [QueuedOperation];

    expect(await a.sync()).toMatchObject({ connection: 'idle', pushed: 1, conflictsOpened: 0 });
    expect(server.pushLog.map((push) => push.operations[0]!.opId)).toEqual([kept.opId, kept.opId]);
    expect(server.pushLog[1]!.operations[0]).toEqual(server.pushLog[0]!.operations[0]);
    expect(server.eventsFor(song.id)).toHaveLength(1);
    expect(server.revisionOf('song', song.id)).toBe('1');
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '1' });
    expect(await a.operations()).toEqual([]);
  });

  it('reinício com tentativa em trânsito: recupera o registro persistido em vez de criar outra operação', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    a.transport.faults.loseResponses = 1;
    await a.sync();
    const [kept] = (await a.operations()) as [QueuedOperation];
    // "Reinício": outro coordenador sobre o mesmo armazenamento.
    const restarted = device(server, 'a');
    Object.assign(restarted, { storage: a.storage });
    const { SyncCoordinator } = await import('./coordinator');
    const coordinator = new SyncCoordinator({ storage: a.storage, transport: a.transport, assets: a.bytes, workspaceId: song.workspaceId, now: a.now, newId: a.newId });
    await coordinator.syncOnce();
    expect(server.pushLog.at(-1)!.operations[0]!.opId).toBe(kept.opId);
    expect(server.eventsFor(song.id)).toHaveLength(1);
  });

  it('envia dependências em chamadas separadas e em ordem: arquivo, louvor, arranjo, repertório', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    const b = device(server, 'b');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    // Gravados fora de ordem, todos offline.
    await a.save('setlist', setlist);
    await a.save('arrangement', arrangement);
    await a.save('asset', asset);
    await a.save('song', song);
    expect((await listPending(a.storage, a.now())).map((item) => [item.entityType, item.phase])).toEqual(
      expect.arrayContaining([
        ['asset', 'waiting-upload'],
        ['arrangement', 'waiting-dependency'],
        ['setlist', 'waiting-dependency'],
        ['song', 'queued'],
      ]),
    );

    expect(await a.sync()).toMatchObject({ connection: 'idle', pushed: 4, uploaded: 1 });
    expect(server.pushLog.map((push) => push.operations.map((operation) => operation.entityType))).toEqual([['asset', 'song'], ['arrangement'], ['setlist']]);
    expect(server.pushLog.flatMap((push) => push.operations).every((operation) => operation.action === 'create')).toBe(true);
    // A referência à letra aponta para a revisão aceita do louvor.
    expect(server.documentOf('arrangement', arrangement.id)).toMatchObject({ basedOnSongRevision: '1' });
    expect(await summarize(a.storage)).toMatchObject({ pending: 0, conflicts: 0 });

    // AT-10: conteúdo e bytes acessíveis no segundo dispositivo.
    expect(await b.sync()).toMatchObject({ downloaded: 0 });
    expect(b.transport.calls).not.toContain('downloadAsset');
    expect(await b.coordinator.requestDownloads([])).toMatchObject({ downloaded: 0 });
    expect(b.transport.calls).not.toContain('downloadAsset');
    b.transport.faults.identity = 'mismatch';
    await expect(b.coordinator.requestDownloads([asset.id])).rejects.toThrow('Entre na conta');
    expect(b.transport.calls).not.toContain('downloadAsset');
    b.transport.faults.identity = 'ok';
    expect(await b.coordinator.requestDownloads([asset.id])).toMatchObject({ downloaded: 1 });
    expect((await b.doc('asset', asset.id)) as AssetDoc).toMatchObject({ remoteState: 'ready', sha256: asset.sha256 });
    expect(b.bytes.blobs.get(asset.sha256)?.size).toBe(asset.byteSize);
    expect(await b.doc('setlist', setlist.id)).toBeDefined();
  });

  it('rejeição por dependência não é repetida com o mesmo opId: nasce outra tentativa depois', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    await a.sync();
    // O louvor some do servidor (excluído por outra pessoa) antes de o arranjo ser enviado.
    server.apply(USER, { opId: server.uuid(), entityType: 'song', entityId: song.id, action: 'delete', baseRevision: '1', schemaVersion: 1, payload: song });
    a.transport.faults.offline = true;
    await a.save('arrangement', withoutAudio);
    a.transport.faults.offline = false;
    // Sem pull antes do envio, para o arranjo chegar a ser recusado.
    const pullFirst = a.transport.pull.bind(a.transport);
    let skipped = false;
    a.transport.pull = async (cursor, limit) => {
      if (!skipped) {
        skipped = true;
        return { changes: [], nextCursor: cursor, hasMore: false };
      }
      return pullFirst(cursor, limit);
    };
    await a.sync();
    const first = server.pushLog.at(-1)!.operations[0]!;
    expect(first.entityType).toBe('arrangement');
    expect(await a.stateOf('arrangement', arrangement.id)).toMatchObject({ dirty: 1, blocked: { code: 'DEPENDENCY_NOT_READY' } });
    expect(await a.operations()).toEqual([]);
    expect((await listPending(a.storage, a.now())).find((item) => item.entityType === 'arrangement')).toMatchObject({ phase: 'waiting-dependency', code: 'DEPENDENCY_NOT_READY' });

    const pushes = server.pushLog.length;
    await a.sync();
    expect(server.pushLog).toHaveLength(pushes);
    a.advance(60_000);
    await a.sync();
    expect(server.pushLog.at(-1)!.operations[0]!.opId).not.toBe(first.opId);
  });

  it('forma lotes de até 20 operações', () => {
    const operations = Array.from({ length: 45 }, (_, index) => ({ opId: String(index), key: `song:${index}`, entityType: 'song', entityId: String(index), action: 'create', baseRevision: '0', capturedGeneration: 1, payload: song, createdAt: '', attempts: 0, firstSentAt: null, lastAttemptAt: null, lastError: null, status: 'queued' }) satisfies QueuedOperation);
    expect(formBatches(operations).map((batch) => batch.length)).toEqual([20, 20, 5]);
  });

  it('IDEMPOTENCY_KEY_REUSED suspende a tentativa como erro de contrato, sem regravar o payload', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    a.transport.faults.pushStatus = { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' };
    expect(await a.sync()).toMatchObject({ connection: 'idle' });
    const [operation] = (await a.operations()) as [QueuedOperation];
    expect(operation).toMatchObject({ status: 'suspended', lastError: 'IDEMPOTENCY_KEY_REUSED' });
    a.transport.faults.pushStatus = null;
    await a.sync();
    expect(server.pushLog).toHaveLength(0);
    expect((await listPending(a.storage, a.now()))[0]).toMatchObject({ phase: 'suspended' });
  });
});

describe('AT-11: conflito explícito e resolução', () => {
  async function conflicted() {
    const world = await pair();
    const { a, b } = world;
    a.transport.faults.offline = true;
    b.transport.faults.offline = true;
    await a.save('song', titled(song, 'Versão de A'));
    await b.save('song', titled(song, 'Versão de B'));
    a.transport.faults.offline = false;
    b.transport.faults.offline = false;
    await a.sync();
    const outcome = await b.sync();
    return { ...world, outcome };
  }

  it('duas edições da mesma revisão: conflito explícito e nenhuma variante perdida', async () => {
    const { server, b, outcome } = await conflicted();
    expect(outcome).toMatchObject({ connection: 'idle', conflictsOpened: 1 });
    const [conflict] = await b.conflicts();
    expect(conflict).toMatchObject({ kind: 'both-edited', baseRevision: '1', remoteRevision: '2', localGeneration: 1, status: 'open' });
    expect(titleOf(conflict!.local)).toBe('Versão de B');
    expect(titleOf(conflict!.remote)).toBe('Versão de A');
    expect(titleOf(conflict!.base ?? undefined)).toBe('Manhã de Gratidão');
    expect(conflict!.remote).toMatchObject({ updatedBy: USER });
    // A variante local continua sendo o documento vivo e não foi enviada.
    expect(titleOf(await b.doc('song', song.id))).toBe('Versão de B');
    expect(titleOf(server.documentOf('song', song.id))).toBe('Versão de A');
    expect((await listPending(b.storage, b.now()))[0]).toMatchObject({ phase: 'conflict' });
    // Enquanto o conflito está aberto, nada é enviado para este registro.
    const pushes = server.pushLog.length;
    await b.sync();
    expect(server.pushLog).toHaveLength(pushes);
  });

  it('o mesmo conflito aparece quando o servidor responde `conflict` a um push (sem pull antes)', async () => {
    const { server, a, b } = await pair();
    await a.save('song', titled(song, 'Versão de A'));
    await a.sync();
    await b.save('song', titled(song, 'Versão de B'));
    // B envia antes de receber: o pull deste ciclo ainda não traz a revisão 2.
    const real = b.transport.pull.bind(b.transport);
    let first = true;
    b.transport.pull = async (cursor, limit) => {
      if (first) {
        first = false;
        return { changes: [], nextCursor: cursor, hasMore: false };
      }
      return real(cursor, limit);
    };
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    expect(server.pushLog.at(-1)!.operations[0]).toMatchObject({ baseRevision: '1' });
    expect(await b.operations()).toEqual([]);
    expect(await b.conflicts()).toMatchObject([{ remoteRevision: '2', baseRevision: '1' }]);
    expect(titleOf(await b.doc('song', song.id))).toBe('Versão de B');
  });

  it('"manter minha versão" envia nova edição sobre a revisão remota e produz nova revisão', async () => {
    const { server, a, b } = await conflicted();
    const [conflict] = await b.conflicts();
    await resolveKeepLocal(resolver(b), conflict!.id);
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1, serverRevision: '2', conflict: null });
    expect(b.storage.archived).toMatchObject([{ reason: 'conflict-remote' }]);
    expect(titleOf(b.storage.archived[0]!.document)).toBe('Versão de A');

    await b.sync();
    expect(server.pushLog.at(-1)!.operations[0]).toMatchObject({ action: 'update', baseRevision: '2' });
    expect(server.revisionOf('song', song.id)).toBe('3');
    expect(titleOf(server.documentOf('song', song.id))).toBe('Versão de B');
    await a.sync();
    expect(titleOf(await a.doc('song', song.id))).toBe('Versão de B');
    expect(await a.conflicts()).toEqual([]);
  });

  it('"manter remoto" arquiva a versão local e adota a remota sem novo envio', async () => {
    const { server, b } = await conflicted();
    const [conflict] = await b.conflicts();
    await resolveKeepRemote(resolver(b), conflict!.id);
    expect(titleOf(await b.doc('song', song.id))).toBe('Versão de A');
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2', conflict: null });
    expect(titleOf(b.storage.archived[0]!.document)).toBe('Versão de B');
    const pushes = server.pushLog.length;
    await b.sync();
    expect(server.pushLog).toHaveLength(pushes);
    await expect(resolveKeepRemote(resolver(b), conflict!.id)).rejects.toBeInstanceOf(ConflictResolutionError);
  });

  it('"combinar" grava a versão revisada sobre a revisão remota e arquiva as duas variantes', async () => {
    const { server, b } = await conflicted();
    const [conflict] = await b.conflicts();
    await resolveKeepLocal(resolver(b), conflict!.id, titled(song, 'Versão de A e B'));
    expect(b.storage.archived.map((entry) => entry.reason).sort()).toEqual(['conflict-local', 'conflict-remote']);
    await b.sync();
    expect(server.revisionOf('song', song.id)).toBe('3');
    expect(titleOf(server.documentOf('song', song.id))).toBe('Versão de A e B');
  });

  it('"criar alternativa" publica a variante local com novo ID e mantém o remoto no original', async () => {
    const { server, b } = await conflicted();
    const [conflict] = await b.conflicts();
    const copyId = b.newId();
    await resolveAlternative(resolver(b), conflict!.id, (local) => [{ entityType: 'song', document: { ...local, id: copyId } as SyncDoc }]);
    expect(titleOf(await b.doc('song', song.id))).toBe('Versão de A');
    await b.sync();
    expect(server.revisionOf('song', song.id)).toBe('2');
    expect(titleOf(server.documentOf('song', copyId))).toBe('Versão de B');
    expect(server.revisionOf('song', copyId)).toBe('1');
  });

  it('outra edição antes de a resolução ser enviada reabre o conflito', async () => {
    const { server, a, b } = await conflicted();
    const [conflict] = await b.conflicts();
    b.transport.faults.offline = true;
    await resolveKeepLocal(resolver(b), conflict!.id);
    await a.save('song', titled(song, 'A mudou de novo'));
    await a.sync();
    b.transport.faults.offline = false;
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    expect(await b.conflicts()).toMatchObject([{ baseRevision: '2', remoteRevision: '3' }]);
    expect(titleOf(server.documentOf('song', song.id))).toBe('A mudou de novo');
    expect(titleOf(await b.doc('song', song.id))).toBe('Versão de B');
  });

  it('nova revisão remota com conflito aberto atualiza o lado remoto do conflito', async () => {
    const { a, b } = await conflicted();
    await a.save('song', titled(song, 'A, terceira revisão'));
    await a.sync();
    await b.sync();
    const conflicts = await b.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ remoteRevision: '3', baseRevision: '1' });
    expect(titleOf(conflicts[0]!.remote)).toBe('A, terceira revisão');
  });

  it('edições iguais nos dois lados não geram conflito', async () => {
    const { a, b } = await pair();
    await a.save('song', titled(song, 'Mesma correção'));
    await b.save('song', titled(song, 'Mesma correção'));
    await a.sync();
    expect(await b.sync()).toMatchObject({ conflictsOpened: 0 });
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2' });
  });
});

describe('AT-13: exclusão em A e edição offline em B', () => {
  it('tombstone propagado, edição preservada para decisão e sem ressurreição do ID', async () => {
    const { server, a, b } = await pair();
    b.transport.faults.offline = true;
    await b.save('song', titled(song, 'Edição offline de B'));
    await a.save('song', { ...song, deletedAt: a.now() } as SyncDoc);
    await a.sync();
    expect(server.pushLog.at(-1)!.operations[0]).toMatchObject({ action: 'delete', baseRevision: '1' });

    b.transport.faults.offline = false;
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    const [conflict] = await b.conflicts();
    expect(conflict).toMatchObject({ kind: 'remote-deleted', remoteRevision: '2' });
    expect(conflict!.remote.deletedAt).not.toBeNull();
    expect(titleOf(await b.doc('song', song.id))).toBe('Edição offline de B');
    // Nenhum envio de B chegou ao servidor para este ID.
    expect(server.pushLog.filter((push) => push.deviceId === (server.pushLog.at(-1)!.deviceId)).length).toBeGreaterThan(0);
    expect(server.eventsFor(song.id).map((event) => event.action)).toEqual(['create', 'delete']);

    await expect(resolveKeepLocal(resolver(b), conflict!.id)).rejects.toMatchObject({ code: 'not-allowed' });
    const copyId = b.newId();
    await resolveAlternative(resolver(b), conflict!.id, (local) => [{ entityType: 'song', document: { ...local, id: copyId } as SyncDoc }]);
    await b.sync();
    expect(server.documentOf('song', song.id)!.deletedAt).not.toBeNull();
    expect(server.revisionOf('song', song.id)).toBe('2');
    expect(titleOf(server.documentOf('song', copyId))).toBe('Edição offline de B');
    expect((await b.doc('song', song.id))!.deletedAt).not.toBeNull();
  });

  it('tombstone chega a quem não editou e o registro sai da biblioteca', async () => {
    const { a, b } = await pair();
    await a.save('song', { ...song, deletedAt: a.now() } as SyncDoc);
    await a.sync();
    await b.sync();
    expect((await b.doc('song', song.id))!.deletedAt).not.toBeNull();
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2' });
  });

  it('criado e excluído sem nunca ter sido enviado não gera operação', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    await a.save('song', { ...song, deletedAt: a.now() } as SyncDoc);
    await a.sync();
    expect(server.pushLog).toHaveLength(0);
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: null });
  });
});

describe('AT-24: recebimento durante edição', () => {
  it('pull com documento sujo não substitui a geração local: registra conflito', async () => {
    const { a, b } = await pair();
    await a.save('song', titled(song, 'Remoto'));
    await a.sync();
    await b.save('song', titled(song, 'Local em edição'));
    await b.sync();
    expect(titleOf(await b.doc('song', song.id))).toBe('Local em edição');
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1, localGeneration: 1, serverRevision: '1' });
    expect(await b.conflicts()).toHaveLength(1);
  });

  it('pull com editor aberto e sem alteração local fica adiado e nunca troca o documento sob o editor', async () => {
    const { a, b } = await pair();
    const key = entityKey('song', song.id);
    b.storage.hold(key);
    await a.save('song', titled(song, 'Remoto'));
    await a.sync();
    expect(await b.sync()).toMatchObject({ adopted: 0, conflictsOpened: 0 });
    expect(titleOf(await b.doc('song', song.id))).toBe('Manhã de Gratidão');
    const state = await b.stateOf('song', song.id);
    expect(state).toMatchObject({ dirty: 0, serverRevision: '1', deferredRemote: { revision: '2' } });

    // Fechar o editor sem alterar: o próximo ciclo adota a versão remota.
    b.storage.hold(key, false);
    await b.sync();
    expect(titleOf(await b.doc('song', song.id))).toBe('Remoto');
    expect(await b.stateOf('song', song.id)).toMatchObject({ serverRevision: '2', deferredRemote: null });
  });

  it('editar depois de um remoto adiado vira conflito, não sobrescrita', async () => {
    const { server, a, b } = await pair();
    const key = entityKey('song', song.id);
    b.storage.hold(key);
    await a.save('song', titled(song, 'Remoto'));
    await a.sync();
    await b.sync();
    await b.save('song', titled(song, 'Digitado com o editor aberto'));
    expect(await b.sync()).toMatchObject({ conflictsOpened: 1 });
    expect(titleOf(await b.doc('song', song.id))).toBe('Digitado com o editor aberto');
    expect(titleOf(server.documentOf('song', song.id))).toBe('Remoto');
    expect(await b.conflicts()).toMatchObject([{ baseRevision: '1', remoteRevision: '2' }]);
  });

  it('carregar a versão remota adiada é uma ação explícita e só vale sem alteração local', async () => {
    const { a, b } = await pair();
    const key = entityKey('song', song.id);
    b.storage.hold(key);
    await a.save('song', titled(song, 'Remoto'));
    await a.sync();
    await b.sync();
    expect(await adoptDeferredRemote(resolver(b), key)).toBe(true);
    expect(titleOf(await b.doc('song', song.id))).toBe('Remoto');
    expect(await adoptDeferredRemote(resolver(b), key)).toBe(false);
  });

  it('pull durante tentativa em trânsito não sobrescreve; reconcilia depois do resultado idempotente', async () => {
    const { server, a, b } = await pair();
    // B envia a revisão 2 e perde a resposta; A grava a 3 em seguida.
    await b.save('song', titled(song, 'B, revisão 2'));
    b.transport.faults.loseResponses = 1;
    await b.sync();
    expect(server.revisionOf('song', song.id)).toBe('2');
    await a.sync();
    await a.save('song', titled(song, 'A, revisão 3'));
    await a.sync();
    expect(server.revisionOf('song', song.id)).toBe('3');

    // B continua editando; o próximo ciclo recebe as revisões 2 e 3 com a tentativa ainda em trânsito.
    await b.save('song', titled(song, 'B, geração 2 local'));
    let duringPull: Awaited<ReturnType<Device['stateOf']>>;
    b.transport.faults.beforePush = async () => {
      duringPull ??= await b.stateOf('song', song.id);
    };
    const outcome = await b.sync();
    expect(duringPull!).toMatchObject({ serverRevision: '1', dirty: 1, deferredRemote: { revision: '3' } });
    // Resultado idempotente: a tentativa tinha sido aceita como revisão 2; o remoto 3 vira conflito com a geração local.
    expect(outcome).toMatchObject({ conflictsOpened: 1 });
    expect(await b.conflicts()).toMatchObject([{ baseRevision: '2', remoteRevision: '3' }]);
    expect(titleOf(await b.doc('song', song.id))).toBe('B, geração 2 local');
    expect(server.eventsFor(song.id)).toHaveLength(3);
  });

  it('pull do próprio evento não reaplica nada', async () => {
    const { a } = await pair();
    await a.save('song', titled(song, 'Minha'));
    expect(await a.sync()).toMatchObject({ pushed: 1, adopted: 0, pulled: 1 });
    expect(await a.stateOf('song', song.id)).toMatchObject({ dirty: 0, serverRevision: '2' });
  });
});

describe('AT-23: cursor ou dispositivo muito antigo', () => {
  it('CURSOR_EXPIRED refaz o bootstrap preservando documentos sujos', async () => {
    const { server, a, b } = await pair();
    const other = songDoc('33333333-3333-4333-8333-3333333333aa', 'Outro louvor');
    await a.save('song', other);
    await a.save('song', titled(song, 'Remoto'));
    await a.sync();
    const localOnly = songDoc('33333333-3333-4333-8333-3333333333bb', 'Criado offline em B');
    b.transport.faults.offline = true;
    await b.save('song', localOnly);
    await b.save('song', titled(song, 'Edição pendente de B'));
    b.transport.faults.offline = false;
    server.minCursor = 3n;

    const outcome = await b.sync();
    expect(outcome).toMatchObject({ connection: 'idle', bootstrapped: true, conflictsOpened: 1 });
    expect(b.transport.calls).toContain('bootstrap');
    expect(await b.meta()).toMatchObject({ cursor: String(server.events.length), needsBootstrap: false });
    // Base limpa substituída, pendências preservadas.
    expect(titleOf(await b.doc('song', other.id))).toBe('Outro louvor');
    expect(titleOf(await b.doc('song', song.id))).toBe('Edição pendente de B');
    expect(server.revisionOf('song', localOnly.id)).toBe('1');
  });

  it('token de bootstrap vencido reinicia a leitura sem tocar nas alterações locais', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    for (let index = 0; index < 120; index += 1) await a.save('song', songDoc(`33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, `Louvor ${index}`));
    await a.sync();
    const b = device(server, 'b');
    await b.save('song', songDoc('33333333-3333-4333-8333-3333333333cc', 'Local de B'));
    b.transport.faults.bootstrapExpiresOnce = true;
    expect(await b.sync()).toMatchObject({ connection: 'idle', bootstrapped: true });
    expect(b.transport.calls.filter((call) => call === 'bootstrap')).toHaveLength(2);
    expect((await b.storage.transaction((tx) => tx.listDocuments('song'))).length).toBe(121);
    expect(await b.storage.transaction((tx) => tx.listStaged())).toEqual([]);
  });

  it('DEVICE_EXPIRED: tentativa antiga não é reenviada; a reconciliação decide pelo conteúdo', async () => {
    const { server, a, b } = await pair();
    const applied = songDoc('33333333-3333-4333-8333-3333333333dd', 'Chegou ao servidor');
    const notApplied = songDoc('33333333-3333-4333-8333-3333333333ee', 'Não chegou');
    // Uma criação chegou ao servidor, mas a resposta se perdeu.
    await b.save('song', applied);
    b.transport.faults.loseResponses = 1;
    await b.sync();
    // Outra foi tentada e nunca chegou.
    await b.save('song', notApplied);
    b.transport.faults.pushStatus = { status: 503, code: 'SERVICE_UNAVAILABLE' };
    await b.sync();
    b.transport.faults.pushStatus = null;
    const stale = (await b.operations()).map((operation) => operation.opId);
    expect(stale).toHaveLength(2);
    // Enquanto isso, outra pessoa alterou o louvor que chegou.
    await a.sync();
    await a.save('song', titled(applied, 'Alterado por A depois'));
    await a.sync();

    const oldDevice = (await b.meta()).deviceId;
    server.expiredDevices.add(oldDevice);
    const pushesBefore = server.pushLog.length;
    const outcome = await b.sync();

    expect(outcome).toMatchObject({ connection: 'idle', bootstrapped: true });
    expect((await b.meta()).deviceId).not.toBe(oldDevice);
    const resent = server.pushLog.slice(pushesBefore).flatMap((push) => push.operations.map((operation) => operation.opId));
    // Nenhum opId antigo saiu de novo.
    expect(resent.filter((opId) => stale.includes(opId))).toEqual([]);
    // O que tinha chegado e foi alterado depois: conflito explícito, nada sobrescrito.
    expect(await b.conflicts()).toMatchObject([{ entityId: applied.id, remoteRevision: '2' }]);
    expect(titleOf(server.documentOf('song', applied.id))).toBe('Alterado por A depois');
    // O que nunca chegou: nova tentativa, com outro opId, criada a partir da comparação com a nova base.
    expect(server.revisionOf('song', notApplied.id)).toBe('1');
    expect(resent).toHaveLength(1);
  });

  it('DEVICE_EXPIRED com conteúdo já aplicado e inalterado: adota sem reenvio', async () => {
    const { server, b } = await pair();
    const applied = songDoc('33333333-3333-4333-8333-3333333333ff', 'Chegou ao servidor');
    await b.save('song', applied);
    b.transport.faults.loseResponses = 1;
    await b.sync();
    server.expiredDevices.add((await b.meta()).deviceId);
    const pushes = server.pushLog.length;
    // O dispositivo só descobre que venceu ao tentar enviar outra coisa.
    await b.save('song', titled(song, 'Outra edição'));
    await b.sync();
    expect(await b.stateOf('song', applied.id)).toMatchObject({ dirty: 0, serverRevision: '1' });
    expect(server.eventsFor(applied.id)).toHaveLength(1);
    expect(server.pushLog.slice(pushes).flatMap((push) => push.operations.map((operation) => operation.entityId))).toEqual([song.id]);
  });
});

describe('AT-19: papel, revogação e identidade', () => {
  it('revogação suspende a fila do espaço e preserva as pendências', async () => {
    const { server, b } = await pair();
    await b.save('song', titled(song, 'Pendente no momento da revogação'));
    b.transport.faults.role = 'revoked';
    const pushes = server.pushLog.length;
    expect(await b.sync()).toMatchObject({ connection: 'revoked', retry: false });
    expect(server.pushLog).toHaveLength(pushes);
    expect(await b.meta()).toMatchObject({ suspended: { code: 'revoked' } });
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1 });
    expect(titleOf(await b.doc('song', song.id))).toBe('Pendente no momento da revogação');
    // Acesso devolvido: a fila volta a andar sozinha.
    b.transport.faults.role = 'editor';
    expect(await b.sync()).toMatchObject({ connection: 'idle', pushed: 1 });
    expect((await b.meta()).suspended).toBeNull();
  });

  it('sessão de outra conta: nada é enviado nem recebido com a identidade errada', async () => {
    const { server, b } = await pair();
    await b.save('song', titled(song, 'Pendência do perfil original'));
    b.transport.faults.identity = 'mismatch';
    const calls = b.transport.calls.length;
    expect(await b.sync()).toMatchObject({ connection: 'identity-mismatch', retry: false, pushed: 0 });
    expect(b.transport.calls).toHaveLength(calls);
    expect(server.revisionOf('song', song.id)).toBe('1');
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1 });
  });

  it('sessão expirada pede login e mantém os dados locais', async () => {
    const { b } = await pair();
    await b.save('song', titled(song, 'Local'));
    b.transport.faults.identity = 'unauthenticated';
    expect(await b.sync()).toMatchObject({ connection: 'auth-required', retry: false });
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1 });
  });

  it('401 no meio do ciclo: renova a sessão uma vez e repete a mesma chamada, com o mesmo opId', async () => {
    const { server, b } = await pair();
    await b.save('song', titled(song, 'Enviado depois de renovar'));
    b.transport.faults.refreshWorks = true;
    // O pull passa; o push encontra a sessão de acesso vencida.
    b.transport.faults.beforePush = null;
    const push = b.transport.push.bind(b.transport);
    let first = true;
    const attempts: string[] = [];
    b.transport.push = async (deviceId, operations) => {
      attempts.push(operations[0]!.opId);
      if (first) {
        first = false;
        b.transport.faults.unauthorized = 1;
      }
      return push(deviceId, operations);
    };
    expect(await b.sync()).toMatchObject({ connection: 'idle', pushed: 1 });
    expect(b.transport.refreshes).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(server.revisionOf('song', song.id)).toBe('2');
  });

  it('sessão vencida ao abrir: renova e sincroniza; se a renovação falha, pede login sem repetir', async () => {
    const { b } = await pair();
    await b.save('song', titled(song, 'Local'));
    b.transport.faults.identity = 'unauthenticated';
    b.transport.faults.refreshWorks = true;
    expect(await b.sync()).toMatchObject({ connection: 'idle', pushed: 1 });

    await b.save('song', titled(song, 'Local de novo'));
    b.transport.faults.unauthorized = 5;
    b.transport.faults.refreshWorks = false;
    expect(await b.sync()).toMatchObject({ connection: 'auth-required', retry: false });
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1 });
  });

  it('operador recebe a biblioteca, mas suas alterações locais não são publicadas', async () => {
    const { server, a, b } = await pair();
    b.transport.faults.role = 'operator';
    await b.save('song', titled(song, 'Tentativa do operador'));
    await a.save('song', songDoc('33333333-3333-4333-8333-333333333311', 'Novo de A'));
    await a.sync();
    expect(await b.sync()).toMatchObject({ connection: 'read-only' });
    expect(titleOf(await b.doc('song', '33333333-3333-4333-8333-333333333311'))).toBe('Novo de A');
    expect(titleOf(server.documentOf('song', song.id))).toBe('Manhã de Gratidão');
    expect(await b.meta()).toMatchObject({ suspended: { code: 'read-only' } });
    expect(await b.stateOf('song', song.id)).toMatchObject({ dirty: 1 });
  });
});

describe('mídia', () => {
  it('arranjo com faixa local espera o upload; sem os bytes fica bloqueado sem travar o resto', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    await a.save('song', song);
    await a.save('asset', asset);
    await a.save('arrangement', arrangement);
    expect(await a.sync()).toMatchObject({ connection: 'idle', pushed: 1, uploaded: 0 });
    expect(server.revisionOf('song', song.id)).toBe('1');
    expect(server.revisionOf('arrangement', arrangement.id)).toBeNull();
    expect(await a.stateOf('asset', asset.id)).toMatchObject({ dirty: 1, blocked: { code: 'LOCAL_BYTES_MISSING' } });
    expect((await a.doc('asset', asset.id)) as AssetDoc).toMatchObject({ remoteState: 'failed' });
  });

  it('upload interrompido continua de onde parou: só vai o que o servidor ainda não tem', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('asset', asset);
    const upload = a.transport.uploadAssetChunk.bind(a.transport);
    let parts = 0;
    a.transport.uploadAssetChunk = async (document, uploadId, offset, chunk) => {
      parts += 1;
      if (parts === 3) a.transport.faults.offline = true;
      return upload(document, uploadId, offset, chunk);
    };
    expect(await a.sync()).toMatchObject({ connection: 'offline', uploaded: 0 });
    expect(server.assets.get(asset.id)).toMatchObject({ state: 'pending' });
    expect(server.assets.get(asset.id)?.partial?.size).toBe(2 * UPLOAD_CHUNK_BYTES);
    a.transport.faults.offline = false;
    expect(await a.sync()).toMatchObject({ connection: 'idle', uploaded: 1, pushed: 1 });
    expect(server.assets.get(asset.id)).toMatchObject({ state: 'ready' });
    expect(server.assets.get(asset.id)?.bytes?.size).toBe(asset.byteSize);
    expect(server.documentOf('asset', asset.id)).toMatchObject({ remoteState: 'ready' });
    // Nenhum byte foi enviado duas vezes.
    expect(a.transport.uploadedBytes).toBe(asset.byteSize);
  });

  it('parte que chegou sem a resposta não é reenviada: o envio se realinha com o servidor', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('asset', asset);
    const register = a.transport.registerAsset.bind(a.transport);
    // O registro informa uma posição atrasada, como se a confirmação da primeira parte tivesse se perdido.
    a.transport.registerAsset = async (document) => {
      const registration = await register(document);
      if (registration.state === 'pending') server.assets.set(document.id, { state: 'pending', uploadId: registration.uploadId, bytes: null, partial: new Blob([new Uint8Array(UPLOAD_CHUNK_BYTES)]) });
      return registration;
    };
    expect(await a.sync()).toMatchObject({ connection: 'idle', uploaded: 1 });
    expect(server.assets.get(asset.id)?.bytes?.size).toBe(asset.byteSize);
  });

  it('falha do servidor no upload não trava os documentos e o ciclo pede nova tentativa', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('song', song);
    await a.save('asset', asset);
    a.transport.faults.uploadStatus = { status: 500, code: 'INTERNAL_ERROR' };
    expect(await a.sync()).toMatchObject({ connection: 'error', retry: true, pushed: 1, uploaded: 0, error: { code: 'INTERNAL_ERROR' } });
    expect(server.revisionOf('song', song.id)).toBe('1');
    expect((await a.doc('asset', asset.id)) as AssetDoc).toMatchObject({ remoteState: 'local' });
    a.transport.faults.uploadStatus = null;
    expect(await a.sync()).toMatchObject({ connection: 'idle', uploaded: 1, pushed: 1 });
  });

  it('informa o andamento em bytes do envio e encerra com nulo', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('asset', asset);
    await a.sync();
    const uploads = a.progress.filter((step) => step?.phase === 'upload');
    expect(uploads[0]).toMatchObject({ loaded: 0, total: asset.byteSize, filename: asset.filename, index: 1, count: 1 });
    expect(uploads.at(-1)).toMatchObject({ loaded: asset.byteSize, total: asset.byteSize });
    expect(uploads.map((step) => step!.loaded)).toEqual([...uploads.map((step) => step!.loaded)].sort((x, y) => x - y));
    expect(a.progress.some((step) => step?.phase === 'documents')).toBe(true);
    expect(a.progress.at(-1)).toBeNull();
  });

  it('durante uma apresentação os downloads ficam suspensos e a biblioteca continua chegando', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    const b = device(server, 'b');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('song', song);
    await a.save('asset', asset);
    await a.save('arrangement', arrangement);
    await a.sync();
    b.state.presenting = true;
    expect(await b.sync()).toMatchObject({ downloaded: 0, downloadsDeferred: 0 });
    expect(await b.coordinator.requestDownloads([asset.id])).toMatchObject({ downloaded: 0, downloadsDeferred: 1 });
    expect(await b.doc('arrangement', arrangement.id)).toBeDefined();
    expect(b.bytes.blobs.size).toBe(0);
    b.state.presenting = false;
    expect(await b.sync()).toMatchObject({ downloaded: 0 });
    expect(await b.coordinator.requestDownloads([asset.id])).toMatchObject({ downloaded: 1 });
  });

  it('bytes baixados que não conferem não ficam disponíveis', async () => {
    const server = new FakeServer();
    const a = device(server, 'a');
    const b = device(server, 'b');
    a.bytes.blobs.set(asset.sha256, new Blob([new Uint8Array(asset.byteSize)]));
    await a.save('song', song);
    await a.save('asset', asset);
    await a.save('arrangement', arrangement);
    await a.sync();
    server.assets.get(asset.id)!.bytes = new Blob([new Uint8Array(10)]);
    expect(await b.sync()).toMatchObject({ downloaded: 0 });
    await expect(b.coordinator.requestDownloads([asset.id])).rejects.toThrow('não confere');
    expect(b.bytes.blobs.size).toBe(0);
  });
});
