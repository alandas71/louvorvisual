import Dexie, { type Table } from 'dexie';

/**
 * Registro dos perfis deste navegador (planejamento/14). Cada conta+equipe tem
 * um banco IndexedDB próprio: biblioteca, fila, cursor, conflitos e mídia
 * nunca se misturam com os de outra conta ou de outro espaço. O perfil pessoal
 * continua no banco original e não é enviado a servidor algum.
 */
export const PROFILE_REGISTRY_DB = 'louvorvisual-profiles';
export const TEAM_DB_PREFIX = 'louvorvisual-team-';

export type TeamRole = 'operator' | 'editor' | 'admin';

export type TeamProfile = {
  profileId: string;
  dbName: string;
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  /** Papel conhecido na última vez online; offline não é garantia de que continua valendo. */
  role: TeamRole;
  deviceId: string;
  createdAt: string;
  lastUsedAt: string;
};

type Setting = { key: 'active'; profileId: string | null };

class ProfileRegistry extends Dexie {
  profiles!: Table<TeamProfile, string>;
  settings!: Table<Setting, string>;
  constructor() {
    super(PROFILE_REGISTRY_DB);
    this.version(1).stores({ profiles: 'profileId, [userId+workspaceId]', settings: 'key' });
  }
}

let registry: ProfileRegistry | null = null;
const open = () => (registry ??= new ProfileRegistry());

/** Perfil de equipe em uso; `null` significa o perfil pessoal deste dispositivo. */
export async function activeTeamProfile(): Promise<TeamProfile | null> {
  const db = open();
  const active = await db.settings.get('active');
  if (!active?.profileId) return null;
  return (await db.profiles.get(active.profileId)) ?? null;
}

export function listTeamProfiles(): Promise<TeamProfile[]> {
  return open().profiles.orderBy('profileId').toArray();
}

export type AccountUser = { id: string; name: string; email: string };
export type AccountWorkspace = { id: string; name: string; role: TeamRole };

/** Cria (na primeira vez) e ativa o perfil desta conta nesta equipe. */
export async function activateTeamProfile(user: AccountUser, workspace: AccountWorkspace, now: string = new Date().toISOString()): Promise<TeamProfile> {
  const db = open();
  return db.transaction('rw', db.profiles, db.settings, async () => {
    const existing = await db.profiles.where('[userId+workspaceId]').equals([user.id, workspace.id]).first();
    const profileId = existing?.profileId ?? crypto.randomUUID();
    const profile: TeamProfile = {
      profileId,
      dbName: `${TEAM_DB_PREFIX}${profileId}`,
      deviceId: existing?.deviceId ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      role: workspace.role,
      lastUsedAt: now,
    };
    await db.profiles.put(profile);
    await db.settings.put({ key: 'active', profileId });
    return profile;
  });
}

export async function activateProfile(profileId: string | null): Promise<void> {
  await open().settings.put({ key: 'active', profileId });
}

export async function updateTeamProfile(profileId: string, changes: Partial<Pick<TeamProfile, 'role' | 'workspaceName' | 'userName'>>): Promise<void> {
  await open().profiles.update(profileId, changes);
}

/**
 * Remove documentos, mídia, sessões e filas daquele perfil, sem tocar no
 * código do aplicativo nem nos outros perfis. Não há como desfazer.
 */
export async function removeTeamProfile(profileId: string): Promise<void> {
  const db = open();
  const profile = await db.profiles.get(profileId);
  if (!profile) return;
  await Dexie.delete(profile.dbName);
  await db.transaction('rw', db.profiles, db.settings, async () => {
    await db.profiles.delete(profileId);
    if ((await db.settings.get('active'))?.profileId === profileId) await db.settings.put({ key: 'active', profileId: null });
  });
}
