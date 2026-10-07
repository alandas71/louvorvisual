import type { Arrangement, IsoInstant, PresentationMode, Uuid } from '@louvorvisual/domain';
import { isRotation, visualPatchIssues, type Rotation, type SessionCheckpoint, type SessionSnapshot, type VisualPatch } from '@louvorvisual/presentation';
import type { LocalDatabase } from './db';
import type { PresentationSessionRow } from './schema';

/**
 * Grava a base de uma sessão nova e encerra as anteriores do mesmo arranjo.
 * O ID pode ter sido combinado antes com a janela de projeção; preparar de
 * novo com o mesmo ID substitui a sessão anterior.
 */
export async function createPresentationSession(db: LocalDatabase, snapshot: SessionSnapshot, baseArrangement: Arrangement, sessionId: Uuid): Promise<PresentationSessionRow> {
  const row: PresentationSessionRow = {
    id: sessionId,
    workspaceId: snapshot.workspaceId,
    songId: snapshot.song.id,
    arrangementId: snapshot.arrangement.id,
    status: 'active',
    createdAt: snapshot.createdAt,
    snapshot,
    baseArrangement,
  };
  await db.transaction('rw', db.presentationSessions, db.presentationCheckpoints, async () => {
    // Versões anteriores mantinham a base das sessões encerradas para sempre.
    // Elas não são recuperáveis e o checkpoint já não tem valor depois do fim,
    // portanto podem sair junto antes de preparar a próxima apresentação.
    const ended = await db.presentationSessions.filter((item) => item.status === 'ended').primaryKeys();
    if (ended.length > 0) {
      await db.presentationCheckpoints.bulkDelete(ended);
      await db.presentationSessions.bulkDelete(ended);
    }
    const previous = await db.presentationSessions.where('[arrangementId+status]').equals([row.arrangementId, 'active']).toArray();
    for (const item of previous) {
      await db.presentationCheckpoints.delete(item.id);
      // Não há como recuperar uma sessão substituída. Removê-la também faz
      // com que um checkpoint atrasado seja ignorado por saveCheckpoint().
      await db.presentationSessions.delete(item.id);
    }
    await db.presentationSessions.put(row);
  });
  return row;
}

export type RecoverableSession = { session: PresentationSessionRow; checkpoint: SessionCheckpoint | null; savedAt: IsoInstant | null };

/** Sessão interrompida deste arranjo, com o último checkpoint confirmado. */
export async function findRecoverableSession(db: LocalDatabase, arrangementId: Uuid): Promise<RecoverableSession | null> {
  const rows = await db.presentationSessions.where('[arrangementId+status]').equals([arrangementId, 'active']).toArray();
  const session = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!session) return null;
  const saved = await db.presentationCheckpoints.get(session.id);
  return { session, checkpoint: saved?.checkpoint ?? null, savedAt: saved?.savedAt ?? null };
}

/** Só confirma depois de o banco concluir a escrita; falha rejeita a promessa. */
export async function saveCheckpoint(db: LocalDatabase, checkpoint: SessionCheckpoint, savedAt: IsoInstant): Promise<void> {
  await db.transaction('rw', db.presentationSessions, db.presentationCheckpoints, async () => {
    const session = await db.presentationSessions.get(checkpoint.sessionId);
    // Sessão encerrada não volta a ter checkpoint por uma gravação atrasada.
    if (session?.status !== 'active') return;
    await db.presentationCheckpoints.put({ sessionId: checkpoint.sessionId, savedAt, checkpoint });
  });
}

export async function endPresentationSession(db: LocalDatabase, sessionId: Uuid): Promise<void> {
  await db.transaction('rw', db.presentationSessions, db.presentationCheckpoints, async () => {
    await db.presentationCheckpoints.delete(sessionId);
    // Depois de anunciar SESSION_ENDED e esperar o controlador se estabilizar,
    // a sessão não é recuperável nem é referência de outro dado local.
    // Apagá-la impede que snapshots de apresentações antigas cresçam sem limite.
    await db.presentationSessions.delete(sessionId);
  });
}

export async function readOutputRotation(db: LocalDatabase): Promise<Rotation> {
  const saved = (await db.outputPreferences.get('public'))?.rotation;
  return isRotation(saved) ? saved : 0;
}

export async function saveOutputRotation(db: LocalDatabase, rotation: Rotation): Promise<void> {
  await db.transaction('rw', db.outputPreferences, async () => {
    await db.outputPreferences.put({ ...(await db.outputPreferences.get('public')), outputId: 'public', rotation });
  });
}

/** Como o operador deixou a última apresentação: vale para a próxima, de qualquer louvor. */
export type OperatorPreferences = { mode: PresentationMode; appearance: VisualPatch };

/** Sem escolha guardada, a apresentação abre no automático e com a aparência de cada louvor. */
export async function readOperatorPreferences(db: LocalDatabase): Promise<OperatorPreferences> {
  const saved = await db.outputPreferences.get('public');
  const appearance = saved?.appearance;
  return {
    mode: saved?.mode === 'manual' ? 'manual' : 'automatic',
    // Um ajuste que este aplicativo não reconhece (tema ou fonte que deixou de existir) é descartado por inteiro.
    appearance: appearance && typeof appearance === 'object' && visualPatchIssues(appearance).length === 0 ? appearance : {},
  };
}

export async function saveOperatorPreferences(db: LocalDatabase, preferences: Partial<OperatorPreferences>): Promise<void> {
  await db.transaction('rw', db.outputPreferences, async () => {
    const saved = await db.outputPreferences.get('public');
    await db.outputPreferences.put({ rotation: 0, ...saved, outputId: 'public', ...preferences });
  });
}
