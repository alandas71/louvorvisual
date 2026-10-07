import 'fake-indexeddb/auto';
import { applyThemeToArrangement, createThemeCopy, themePreset, type Theme } from '@louvorvisual/domain';
import { resolveArrangementVisual } from '@louvorvisual/presentation';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalDatabase } from './db';
import { getEntityState, LocalSaveError, saveDocuments } from './repository';
import { sampleSong, testContext, testDatabase } from './testing';
import { deleteTheme, listThemes, saveTheme } from './themes';

let db: LocalDatabase;
afterEach(async () => {
  await db?.delete();
});

const refused = async (theme: Theme) => {
  const error = await saveTheme(db, theme).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalSaveError);
  expect((error as LocalSaveError).code).toBe('invalid-document');
};

describe('temas personalizados (AT-26)', () => {
  it('a cópia é gravada com pendência de sincronização e aparece na lista do espaço', async () => {
    db = testDatabase();
    const context = testContext();
    const theme = createThemeCopy(themePreset('violeta'), 'Violeta (cópia)', context);
    await saveTheme(db, theme);
    expect(await listThemes(db, context.workspaceId)).toEqual([theme]);
    expect(await getEntityState(db, 'theme', theme.id)).toMatchObject({ dirty: 1, localGeneration: 1 });
  });

  it('fundo claro, contraste baixo, cor inválida e campo de imagem são recusados sem gravar nada', async () => {
    db = testDatabase();
    const context = testContext();
    const theme = createThemeCopy(themePreset('grafite'), 'Culto da noite', context);
    await refused({ ...theme, palette: { backgroundColor: '#FFFFFF', textColor: '#000000' } });
    await refused({ ...theme, palette: { backgroundColor: '#111827', textColor: '#4B5563' } });
    await refused({ ...theme, palette: { backgroundColor: 'preto', textColor: '#FFFFFF' } });
    await refused({ ...theme, backgroundImage: 'https://example.test/fundo.jpg' } as Theme);
    await refused({ ...theme, palette: { ...theme.palette, backgroundImageAssetId: context.newId() } } as unknown as Theme);
    expect(await listThemes(db, context.workspaceId)).toEqual([]);
  });

  it('o arranjo que recebeu o tema guarda a cópia: excluir o tema não muda o que ele desenha', async () => {
    db = testDatabase();
    const context = testContext();
    const { song, arrangement } = sampleSong();
    const theme = { ...createThemeCopy(themePreset('grafite'), 'Culto da noite', context), palette: { backgroundColor: '#101010', textColor: '#FFE9A8' }, shadow: 'soft' as const };
    await saveTheme(db, theme);
    const themed = { ...arrangement, ...applyThemeToArrangement(theme, { fontId: 'lato' }) };
    await saveDocuments(db, [{ entityType: 'song', document: song }, { entityType: 'arrangement', document: themed }]);

    await deleteTheme(db, theme.id, testContext());
    expect(await listThemes(db, context.workspaceId)).toEqual([]);
    // Exclusão sincronizável: o registro fica, marcado.
    expect((await db.themes.get(theme.id))?.deletedAt).not.toBeNull();

    const visual = resolveArrangementVisual(themed);
    expect(visual.style.palette).toEqual({ backgroundColor: '#101010', textColor: '#FFE9A8' });
    expect(visual.style.shadow).toBe('soft');
    // A fonte escolhida à mão no arranjo permanece.
    expect(visual.fontId).toBe('lato');
  });
});
