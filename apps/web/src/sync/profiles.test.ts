import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { LocalDatabase } from '@/local/db';
import { ensureProfile, saveDocuments } from '@/local/repository';
import { sampleSong, testContext } from '@/local/testing';
import { activateProfile, activateTeamProfile, activeTeamProfile, listTeamProfiles, removeTeamProfile } from './profiles';

const ana = { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Ana', email: 'ana@example.test' };
const bruno = { id: '0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Bruno', email: 'bruno@example.test' };
const vila = { id: '6f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d', name: 'Louvor da Vila', role: 'admin' as const };
const centro = { id: '7f1d2c3a-8b4e-4f5a-9c6d-7e8f9a0b1c2d', name: 'Louvor do Centro', role: 'editor' as const };

describe('perfis locais isolados', () => {
  it('cada conta+equipe tem banco, dispositivo e fila próprios; reabrir o mesmo par reaproveita o perfil', async () => {
    expect(await activeTeamProfile()).toBeNull();
    const anaVila = await activateTeamProfile(ana, vila);
    const brunoVila = await activateTeamProfile(bruno, vila);
    const anaCentro = await activateTeamProfile(ana, centro);
    expect(new Set([anaVila.dbName, brunoVila.dbName, anaCentro.dbName]).size).toBe(3);
    expect(new Set([anaVila.deviceId, brunoVila.deviceId, anaCentro.deviceId]).size).toBe(3);
    expect((await activeTeamProfile())?.profileId).toBe(anaCentro.profileId);

    const again = await activateTeamProfile(ana, { ...vila, role: 'editor' });
    expect(again).toMatchObject({ profileId: anaVila.profileId, dbName: anaVila.dbName, deviceId: anaVila.deviceId, role: 'editor' });
    expect(await listTeamProfiles()).toHaveLength(3);

    // Uma pendência gravada no perfil de Ana não existe no banco de Bruno.
    const context = testContext();
    const anaDb = new LocalDatabase(anaVila.dbName);
    const brunoDb = new LocalDatabase(brunoVila.dbName);
    expect(await ensureProfile(anaDb, () => crypto.randomUUID(), context.now, { profileId: anaVila.profileId, workspaceId: vila.id, userId: ana.id, deviceId: anaVila.deviceId })).toMatchObject({ kind: 'team', userId: ana.id, workspaceId: vila.id });
    await saveDocuments(anaDb, [{ entityType: 'song', document: sampleSong(context).song }]);
    expect(await anaDb.entityStates.count()).toBe(1);
    expect(await brunoDb.entityStates.count()).toBe(0);
    expect(await brunoDb.songs.count()).toBe(0);
    anaDb.close();
    brunoDb.close();
  });

  it('remover um perfil apaga só o banco dele e volta ao perfil pessoal se era o ativo', async () => {
    const [anaVila] = (await listTeamProfiles()).filter((profile) => profile.userId === ana.id && profile.workspaceId === vila.id);
    await activateProfile(anaVila!.profileId);
    const brunoVila = (await listTeamProfiles()).find((profile) => profile.userId === bruno.id);
    expect(await Dexie.exists(anaVila!.dbName)).toBe(true);
    await removeTeamProfile(anaVila!.profileId);
    expect(await activeTeamProfile()).toBeNull();
    expect(await Dexie.exists(anaVila!.dbName)).toBe(false);
    // O banco do outro perfil, aberto no teste anterior, continua lá.
    expect(await Dexie.exists(brunoVila!.dbName)).toBe(true);
    expect(await listTeamProfiles()).toHaveLength(2);
  });
});
