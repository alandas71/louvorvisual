export const ROLES = ['operator', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type User = { id: string; name: string; email: string; passwordHash: string; status: 'active' | 'blocked'; createdAt: string };
export type Membership = { workspaceId: string; userId: string; role: Role; status: 'active' | 'revoked'; createdAt: string; updatedAt: string };
export type Workspace = { id: string; name: string; timezone: string; createdAt: string };
export type Asset = { id: string; workspaceId: string; sha256: string; filename: string; mimeType: 'audio/mpeg' | 'audio/wav'; byteSize: number; audioKind: 'original' | 'playback'; durationMs: number | null; state: 'pending' | 'ready' | 'failed'; uploadId: string; createdAt: string; updatedAt: string };
export type Invitation = { id: string; workspaceId: string; email: string; role: Role; expiresAt: number; acceptedAt: number | null; createdBy: string };

export class IdentityError extends Error { constructor(readonly code: string, readonly status: number, message: string) { super(message); } }

export interface IdentityStore {
  register(name: string, email: string, password: string): Promise<User>;
  login(email: string, password: string): Promise<User>;
  issue(userId: string, familyId?: string): Promise<{ accessToken: string; refreshToken: string }>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>;
  logout(refreshToken: string | undefined): Promise<void>;
  authenticate(accessToken: string | undefined): Promise<User | null>;
  createWorkspace(userId: string, name: string, timezone: string): Promise<Workspace>;
  listWorkspaces(userId: string): Promise<Array<Workspace & { role: Role }>>;
  membership(workspaceId: string, userId: string): Promise<Membership | null>;
  requireRole(workspaceId: string, userId: string, roles: readonly Role[]): Promise<Membership>;
  listMembers(workspaceId: string, requester: string): Promise<Array<Membership & { user: ReturnType<typeof safeUser> }>>;
  invite(workspaceId: string, requester: string, email: string, role: Role): Promise<{ token: string; invitation: Invitation }>;
  acceptInvitation(token: string, userId: string): Promise<Membership>;
  updateMember(workspaceId: string, requester: string, targetUserId: string, patch: { role?: Role; status?: 'active' | 'revoked' }): Promise<Membership>;
  registerAsset(workspaceId: string, userId: string, value: Omit<Asset, 'state' | 'uploadId' | 'createdAt' | 'updatedAt'>): Promise<Asset>;
  getAsset(workspaceId: string, userId: string, assetId: string): Promise<Asset>;
  upload(workspaceId: string, userId: string, assetId: string, uploadId: string | undefined, data: Buffer, contentType: string | undefined): Promise<Asset>;
  content(workspaceId: string, userId: string, assetId: string): Promise<Buffer>;
  deleteAsset(workspaceId: string, userId: string, assetId: string): Promise<void>;
  recoverPartialUploads(): Promise<number>;
}

export const safeUser = (user: User) => ({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });
