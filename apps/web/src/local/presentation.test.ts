import 'fake-indexeddb/auto';
import { emptyOverrides, ManualClock, prepareSnapshot, PresentationEngine } from '@louvorvisual/presentation';
import { describe, expect, it } from 'vitest';
import { createPresentationSession, endPresentationSession, findRecoverableSession, readOperatorPreferences, readOutputRotation, saveCheckpoint, saveOperatorPreferences, saveOutputRotation } from './presentation';
import { sampleSong, testDatabase } from './testing';

function prepared(id: string, now = '2026-10-05T12:00:00.000Z') {
  const { song, arrangement } = sampleSong();
  const result = prepareSnapshot({ id, now, song, arrangement, songGeneration: 1, arrangementGeneration: 1 });
  if (!result.ok) throw new Error('snapshot inválido');
  return { arrangement, snapshot: result.snapshot };
}

describe('sessões de apresentação no banco local', () => {
  it('guarda a base, o checkpoint mais recente e devolve os dois para recuperar', async () => {
    const db = testDatabase();
    const { arrangement, snapshot } = prepared('sessao-1');
    await createPresentationSession(db, snapshot, arrangement, 'sessao-1');
    expect(await findRecoverableSession(db, arrangement.id)).toMatchObject({ session: { id: 'sessao-1', status: 'active' }, checkpoint: null });

    const engine = new PresentationEngine({ snapshot, clock: new ManualClock(), sessionId: 'sessao-1', mode: 'manual' });
    engine.execute({ type: 'start' });
    engine.execute({ type: 'next' });
    engine.execute({ type: 'adjust', scope: 'song', patch: { themePresetId: 'violeta' } });
    await saveCheckpoint(db, engine.checkpoint(), '2026-10-05T12:01:00.000Z');
    engine.execute({ type: 'stepFontSize', direction: 1, scope: 'occurrence' });
    await saveCheckpoint(db, engine.checkpoint(), '2026-10-05T12:02:00.000Z');

    const found = await findRecoverableSession(db, arrangement.id);
    expect(found?.savedAt).toBe('2026-10-05T12:02:00.000Z');
    expect(found?.session.snapshot).toEqual(snapshot);
    expect(found?.session.baseArrangement).toEqual(arrangement);
    const restored = new PresentationEngine({ snapshot: found!.session.snapshot, clock: new ManualClock(), sessionId: 'sessao-1', checkpoint: found!.checkpoint! });
    expect(restored.getState()).toMatchObject({ status: 'paused', currentIndex: 1, overridesRevision: 2 });
    expect(restored.getView().current).toMatchObject({ themePresetId: 'violeta', style: { fontSizePx: 100 } });
    expect(await db.presentationCheckpoints.count()).toBe(1);
    db.close();
  });

  it('preparar de novo remove a sessão anterior e o checkpoint; uma gravação atrasada é ignorada', async () => {
    const db = testDatabase();
    const first = prepared('sessao-1');
    await createPresentationSession(db, first.snapshot, first.arrangement, 'sessao-1');
    const checkpoint = { ...new PresentationEngine({ snapshot: first.snapshot, clock: new ManualClock(), sessionId: 'sessao-1' }).checkpoint(), overrides: emptyOverrides().current };
    await saveCheckpoint(db, checkpoint, 'a');

    const second = { ...first.snapshot, id: 'sessao-2', createdAt: '2026-10-05T13:00:00.000Z' };
    await createPresentationSession(db, second, first.arrangement, 'sessao-2');
    expect((await findRecoverableSession(db, first.arrangement.id))?.session.id).toBe('sessao-2');
    await saveCheckpoint(db, checkpoint, 'b');
    expect(await db.presentationSessions.get('sessao-1')).toBeUndefined();
    expect(await db.presentationCheckpoints.get('sessao-1')).toBeUndefined();

    await endPresentationSession(db, 'sessao-2');
    expect(await findRecoverableSession(db, first.arrangement.id)).toBeNull();
    expect(await db.presentationSessions.get('sessao-2')).toBeUndefined();
    expect(await db.presentationCheckpoints.get('sessao-2')).toBeUndefined();
    db.close();
  });

  it('remove na próxima preparação sessões encerradas por versões anteriores', async () => {
    const db = testDatabase();
    const first = prepared('sessao-antiga');
    await db.presentationSessions.add({
      id: 'sessao-encerrada',
      workspaceId: first.snapshot.workspaceId,
      songId: first.snapshot.song.id,
      arrangementId: first.arrangement.id,
      status: 'ended',
      createdAt: '2026-10-04T12:00:00.000Z',
      snapshot: first.snapshot,
      baseArrangement: first.arrangement,
    });
    await db.presentationCheckpoints.add({
      sessionId: 'sessao-encerrada',
      savedAt: '2026-10-04T12:01:00.000Z',
      checkpoint: new PresentationEngine({ snapshot: first.snapshot, clock: new ManualClock(), sessionId: 'sessao-encerrada' }).checkpoint(),
    });

    const next = prepared('sessao-nova');
    await createPresentationSession(db, next.snapshot, next.arrangement, 'sessao-nova');

    expect(await db.presentationSessions.get('sessao-encerrada')).toBeUndefined();
    expect(await db.presentationCheckpoints.get('sessao-encerrada')).toBeUndefined();
    expect(await db.presentationSessions.get('sessao-nova')).toMatchObject({ status: 'active' });
    db.close();
  });

  it('rotação da saída fica nas preferências do dispositivo', async () => {
    const db = testDatabase();
    expect(await readOutputRotation(db)).toBe(0);
    await saveOutputRotation(db, 90);
    expect(await readOutputRotation(db)).toBe(90);
    db.close();
  });

  it('preferências do operador: automático por padrão; modo e aparência ficam para a próxima apresentação', async () => {
    const db = testDatabase();
    expect(await readOperatorPreferences(db)).toEqual({ mode: 'automatic', appearance: {} });
    await saveOutputRotation(db, 90);
    await saveOperatorPreferences(db, { mode: 'manual' });
    await saveOperatorPreferences(db, { appearance: { themePresetId: 'violeta', fontSizePx: 80 } });
    expect(await readOperatorPreferences(db)).toEqual({ mode: 'manual', appearance: { themePresetId: 'violeta', fontSizePx: 80 } });
    // Rotação e preferências dividem o mesmo registro sem se apagar.
    await saveOutputRotation(db, 0);
    expect(await readOutputRotation(db)).toBe(0);
    expect((await readOperatorPreferences(db)).mode).toBe('manual');
    // Um ajuste que deixou de ser válido é descartado, não aplicado pela metade.
    await db.outputPreferences.put({ outputId: 'public', rotation: 0, appearance: { fontSizePx: 99999 } });
    expect(await readOperatorPreferences(db)).toEqual({ mode: 'automatic', appearance: {} });
    db.close();
  });
});
