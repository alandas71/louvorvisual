import { touch, type AuthoringContext, type Theme, type Uuid } from '@louvorvisual/domain';
import type { LocalDatabase } from './db';
import { saveDocuments } from './repository';

/** Temas personalizados do espaço, por nome. Os de fábrica são catálogo do aplicativo e não ficam aqui. */
export async function listThemes(db: LocalDatabase, workspaceId: Uuid): Promise<Theme[]> {
  const rows = await db.themes.where('workspaceId').equals(workspaceId).toArray();
  return rows.filter((row) => row.deletedAt === null).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.createdAt.localeCompare(b.createdAt));
}

/** Grava o tema; fundo claro, contraste baixo ou campo fora do contrato fazem `saveDocuments` recusar. */
export async function saveTheme(db: LocalDatabase, theme: Theme): Promise<void> {
  await saveDocuments(db, [{ entityType: 'theme', document: theme }]);
}

/** Exclusão sincronizável. Louvores que já receberam o tema guardam a própria cópia e não mudam. */
export async function deleteTheme(db: LocalDatabase, themeId: Uuid, context: Pick<AuthoringContext, 'userId' | 'now'>): Promise<void> {
  const theme = await db.themes.get(themeId);
  if (!theme || theme.deletedAt !== null) return;
  await saveDocuments(db, [{ entityType: 'theme', document: { ...touch(theme, context), deletedAt: context.now } }]);
}
