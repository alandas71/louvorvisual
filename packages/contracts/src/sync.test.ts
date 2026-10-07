import { describe, expect, it } from 'vitest';
import { song, theme } from './fixtures';
import { cursorSchema, syncOperationSchema, syncPushRequestSchema } from './sync';

describe('contratos de sincronização', () => {
  it('exige base zero para criação e IDs coerentes', () => {
    const operation = {
      opId: '00000000-0000-4000-8000-000000000010',
      entityType: 'song',
      entityId: song.id,
      action: 'create',
      baseRevision: '0',
      schemaVersion: 1,
      payload: song,
    };
    expect(syncOperationSchema.parse(operation).baseRevision).toBe('0');
    expect(() => syncOperationSchema.parse({ ...operation, baseRevision: '1' })).toThrow();
    expect(() => syncOperationSchema.parse({ ...operation, entityId: '00000000-0000-4000-8000-000000000011' })).toThrow();
  });

  it('limita lote a vinte operações', () => {
    const operation = {
      opId: '00000000-0000-4000-8000-000000000010', entityType: 'song', entityId: song.id,
      action: 'create', baseRevision: '0', schemaVersion: 1, payload: song,
    };
    expect(() => syncPushRequestSchema.parse({
      deviceId: '00000000-0000-4000-8000-000000000012', clientSchemaVersion: 1,
      operations: Array.from({ length: 21 }, () => operation),
    })).toThrow();
  });
});

describe('cursores e tipos de documento', () => {
  const operation = {
    opId: '00000000-0000-4000-8000-000000000010', entityType: 'song', entityId: song.id,
    action: 'update', baseRevision: '10', schemaVersion: 1, payload: song,
  };

  it('aceita inteiros decimais de qualquer tamanho, sem zeros à esquerda', () => {
    for (const cursor of ['0', '7', '10', '1042', '9007199254740993']) expect(cursorSchema.safeParse(cursor).success).toBe(true);
    for (const cursor of ['', '01', '-1', '1.5', '1\\d', 'abc']) expect(cursorSchema.safeParse(cursor).success).toBe(false);
  });

  it('aceita atualização com revisão base de dois dígitos', () => {
    expect(syncOperationSchema.safeParse(operation).success).toBe(true);
  });

  it('recusa payload de um tipo diferente de entityType', () => {
    expect(syncOperationSchema.safeParse({ ...operation, entityId: theme.id, payload: theme }).success).toBe(false);
    expect(syncOperationSchema.safeParse({ ...operation, entityType: 'theme', entityId: theme.id, payload: theme }).success).toBe(true);
  });
});
