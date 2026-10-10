import { describe, expect, it } from 'vitest';
import { arrangement, asset, setlist, song, theme } from './fixtures';
import { arrangementSchema, assetSchema, documentSchemas, setlistSchema, songSchema, themeSchema } from './index';

function messages(result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
}

describe('documentos válidos', () => {
  it.each([
    ['song', song],
    ['arrangement', arrangement],
    ['theme', theme],
    ['setlist', setlist],
    ['asset', asset],
  ] as const)('%s é aceito sem alteração', (entityType, document) => {
    expect(documentSchemas[entityType].parse(document)).toEqual(document);
  });

  it('documentos sobrevivem a JSON', () => {
    expect(arrangementSchema.parse(JSON.parse(JSON.stringify(arrangement)))).toEqual(arrangement);
  });
});

describe('songSchema', () => {
  it('exige título', () => {
    expect(messages(songSchema.safeParse({ ...song, title: '   ' }))).toEqual(['title: blank']);
  });

  it('recusa campo desconhecido em vez de descartá-lo', () => {
    expect(songSchema.safeParse({ ...song, preco: 10 }).success).toBe(false);
  });

  it('recusa versão de esquema mais nova', () => {
    expect(songSchema.safeParse({ ...song, schemaVersion: 2 }).success).toBe(false);
  });

  it('recusa tipo de seção desconhecido', () => {
    const sections = [{ ...song.sections[0], kind: 'capitulo' }];
    expect(songSchema.safeParse({ ...song, sections }).success).toBe(false);
  });
});

describe('arrangementSchema', () => {
  const [first, second, third] = arrangement.occurrences;

  it('aceita duração nula sem áudio vinculado', () => {
    const document = {
      ...arrangement,
      audioBindings: [],
      selectedAudioBindingId: null,
      occurrences: [{ ...first, durationMs: null }, second, third],
    };
    expect(arrangementSchema.safeParse(document).success).toBe(true);
  });

  it.each([0, 499, 600_001, 1500.5])('recusa duração %s', (durationMs) => {
    const document = { ...arrangement, occurrences: [{ ...first, durationMs }, second, third] };
    expect(arrangementSchema.safeParse(document).success).toBe(false);
  });

  it('informa invariantes do agregado com o caminho do campo', () => {
    const document = {
      ...arrangement,
      audioBindings: [],
      selectedAudioBindingId: null,
      occurrences: [first, { ...second, id: first?.id }, third],
    };
    expect(messages(arrangementSchema.safeParse(document))).toEqual(['occurrences.1.id: duplicate-occurrence-id']);
  });

  it('vínculo de áudio exige tempo em todas as ocorrências', () => {
    const document = { ...arrangement, occurrences: [first, { ...second, durationMs: null }, third] };
    expect(messages(arrangementSchema.safeParse(document))).toEqual([
      'occurrences.1.durationMs: linked-binding-missing-duration',
    ]);
  });

  it('distingue tema embutido de cópia da equipe', () => {
    expect(arrangementSchema.safeParse({ ...arrangement, themeRef: { kind: 'workspace', themeId: theme.id } }).success).toBe(true);
    expect(arrangementSchema.safeParse({ ...arrangement, themeRef: { kind: 'builtin', themeId: theme.id } }).success).toBe(false);
  });
});

describe('themeSchema', () => {
  it('recusa fundo claro', () => {
    const palette = { backgroundColor: '#FFFFFF', textColor: '#000000' };
    expect(messages(themeSchema.safeParse({ ...theme, palette }))).toEqual(['palette: background-not-dark']);
  });

  it('recusa contraste abaixo de 7:1', () => {
    const palette = { backgroundColor: '#111827', textColor: '#4B5563' };
    expect(messages(themeSchema.safeParse({ ...theme, palette }))).toEqual(['palette: low-contrast']);
  });

  it('recusa tamanho fora dos limites e peso sem arquivo', () => {
    expect(themeSchema.safeParse({ ...theme, fontSizePx: 28 }).success).toBe(false);
    expect(themeSchema.safeParse({ ...theme, fontWeight: 500 }).success).toBe(false);
  });
});

describe('setlistSchema', () => {
  it('permite repetir arranjo, mas não ID de item', () => {
    const [first, second] = setlist.items;
    const items = [first, { ...second, id: first?.id }];
    expect(messages(setlistSchema.safeParse({ ...setlist, items }))).toEqual(['items.1.id: duplicate-item-id']);
  });

  it('recusa data com horário', () => {
    expect(setlistSchema.safeParse({ ...setlist, serviceDate: '2026-10-11T10:00:00Z' }).success).toBe(false);
  });
});

describe('assetSchema', () => {
  it.each(['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm'])('aceita %s', (mimeType) => {
    expect(assetSchema.safeParse({ ...asset, mimeType }).success).toBe(true);
  });

  it('recusa formato não suportado e arquivo acima de 100 MiB', () => {
    expect(assetSchema.safeParse({ ...asset, mimeType: 'application/pdf' }).success).toBe(false);
    expect(assetSchema.safeParse({ ...asset, byteSize: 100 * 1024 * 1024 + 1 }).success).toBe(false);
  });

  it('recusa hash que não seja SHA-256 em hexadecimal minúsculo', () => {
    expect(assetSchema.safeParse({ ...asset, sha256: 'ABC' }).success).toBe(false);
  });
});
