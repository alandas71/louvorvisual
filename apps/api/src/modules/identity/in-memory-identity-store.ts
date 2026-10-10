import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { sniffAudioType } from '@louvorvisual/domain';
import { type Asset, type AssetUpload, type IdentityStore, IdentityError, type Membership, ROLES, type Role, safeUser, type User, type Workspace } from './identity-store';

export { IdentityError, ROLES, safeUser, type Asset, type Membership, type Role, type User, type Workspace } from './identity-store';
type Session = { id: string; userId: string; refreshHash: string; familyId: string; expiresAt: number; revokedAt: number | null };
type Invitation = { id: string; workspaceId: string; email: string; role: Role; tokenHash: string; expiresAt: number; acceptedAt: number | null; createdBy: string };
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const now = () => new Date().toISOString();

export class InMemoryIdentityStore implements IdentityStore {
  private readonly users = new Map<string, User>();
  private readonly userByEmail = new Map<string, string>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly memberships = new Map<string, Membership>();
  private readonly invitations = new Map<string, Invitation>();
  private readonly sessions = new Map<string, Session>();
  private readonly assets = new Map<string, Asset>();
  private readonly bytes = new Map<string, Buffer>();
  /** Partes já recebidas de um envio ainda não concluído. */
  private readonly partial = new Map<string, Buffer>();
  private received(asset: Asset): AssetUpload { return { ...asset, receivedBytes: asset.state === 'ready' ? asset.byteSize : this.partial.get(asset.id)?.length ?? 0 }; }
  private readonly access = new Map<string, { sessionId: string; expiresAt: number }>();

  async register(name: string, email: string, password: string): Promise<User> {
    email = normalizeEmail(email);
    if (this.userByEmail.has(email)) throw new IdentityError('EMAIL_ALREADY_EXISTS', 409, 'Este e-mail já está cadastrado.');
    const user: User = { id: randomUUID(), name: name.trim(), email, passwordHash: hashPassword(password), status: 'active', createdAt: now() };
    this.users.set(user.id, user); this.userByEmail.set(email, user.id); return user;
  }
  async login(email: string, password: string): Promise<User> {
    const user = this.users.get(this.userByEmail.get(normalizeEmail(email)) ?? '');
    if (!user || !verifyPassword(password, user.passwordHash) || user.status !== 'active') throw new IdentityError('INVALID_CREDENTIALS', 401, 'E-mail ou senha inválidos.');
    return user;
  }
  async issue(userId: string, familyId: string = randomUUID()): Promise<{ accessToken: string; refreshToken: string }> {
    const user = this.requireUser(userId);
    if (user.status !== 'active') throw new IdentityError('SESSION_EXPIRED', 401, 'Sessão inválida.');
    const session: Session = { id: randomUUID(), userId, refreshHash: '', familyId, expiresAt: Date.now() + 30 * 86400_000, revokedAt: null };
    const refreshToken = `${session.id}.${randomBytes(32).toString('base64url')}`;
    session.refreshHash = tokenHash(refreshToken); this.sessions.set(session.id, session);
    return { accessToken: this.issueAccess(session.id), refreshToken };
  }
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const sessionId = refreshToken.split('.', 1)[0] ?? '';
    const old = this.sessions.get(sessionId);
    if (!old || old.expiresAt < Date.now()) throw new IdentityError('SESSION_EXPIRED', 401, 'Sessão expirada.');
    if (old.revokedAt || !safeEquals(old.refreshHash, tokenHash(refreshToken))) {
      this.revokeFamily(old.familyId); throw new IdentityError('SESSION_REUSED', 401, 'Sessão revogada por reutilização do refresh.');
    }
    old.revokedAt = Date.now();
    return this.issue(old.userId, old.familyId);
  }
  async logout(refreshToken: string | undefined): Promise<void> { const id = refreshToken?.split('.', 1)[0]; if (id && this.sessions.has(id)) this.revokeFamily(this.sessions.get(id)!.familyId); }
  async authenticate(accessToken: string | undefined): Promise<User | null> {
    if (!accessToken) return null; const access = this.access.get(accessToken); if (!access || access.expiresAt < Date.now()) return null;
    const session = this.sessions.get(access.sessionId); if (!session || session.revokedAt || session.expiresAt < Date.now()) return null;
    const user = this.users.get(session.userId); return user?.status === 'active' ? user : null;
  }
  async createWorkspace(userId: string, name: string, timezone: string): Promise<Workspace> {
    this.requireUser(userId); const workspace = { id: randomUUID(), name: name.trim(), timezone, createdAt: now() }; this.workspaces.set(workspace.id, workspace);
    this.memberships.set(this.memberKey(workspace.id, userId), { workspaceId: workspace.id, userId, role: 'admin', status: 'active', createdAt: workspace.createdAt, updatedAt: workspace.createdAt }); return workspace;
  }
  async listWorkspaces(userId: string) { return [...this.memberships.values()].filter((m) => m.userId === userId && m.status === 'active').map((m) => ({ ...this.workspaces.get(m.workspaceId)!, role: m.role })); }
  async membership(workspaceId: string, userId: string) { return this.memberships.get(this.memberKey(workspaceId, userId)) ?? null; }
  async requireRole(workspaceId: string, userId: string, roles: readonly Role[]): Promise<Membership> {
    const m = await this.membership(workspaceId, userId); if (!m || m.status !== 'active') throw new IdentityError('WORKSPACE_ACCESS_REVOKED', 403, 'Acesso ao espaço revogado.');
    if (!roles.includes(m.role)) throw new IdentityError('WORKSPACE_FORBIDDEN', 403, 'Você não tem permissão neste espaço.'); return m;
  }
  async listMembers(workspaceId: string, requester: string) { await this.requireRole(workspaceId, requester, ROLES); return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId).map((m) => ({ ...m, user: safeUser(this.requireUser(m.userId)) })); }
  async invite(workspaceId: string, requester: string, email: string, role: Role): Promise<{ token: string; invitation: Omit<Invitation, 'tokenHash'> }> {
    await this.requireRole(workspaceId, requester, ['admin']); if (!this.workspaces.has(workspaceId)) throw new IdentityError('NOT_FOUND', 404, 'Espaço não encontrado.');
    const token = randomBytes(32).toString('base64url'); const invitation: Invitation = { id: randomUUID(), workspaceId, email: normalizeEmail(email), role, tokenHash: tokenHash(token), expiresAt: Date.now() + 7 * 86400_000, acceptedAt: null, createdBy: requester };
    this.invitations.set(invitation.id, invitation); return { token, invitation: { id: invitation.id, workspaceId: invitation.workspaceId, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, acceptedAt: invitation.acceptedAt, createdBy: invitation.createdBy } };
  }
  async acceptInvitation(token: string, userId: string): Promise<Membership> {
    const invite = [...this.invitations.values()].find((item) => safeEquals(item.tokenHash, tokenHash(token)));
    const user = this.requireUser(userId); if (!invite || invite.acceptedAt || invite.expiresAt < Date.now()) throw new IdentityError('INVITATION_INVALID', 400, 'Convite inválido ou expirado.');
    if (invite.email !== user.email) throw new IdentityError('INVITATION_RECIPIENT_MISMATCH', 403, 'Este convite pertence a outro e-mail.');
    invite.acceptedAt = Date.now(); const membership: Membership = { workspaceId: invite.workspaceId, userId, role: invite.role, status: 'active', createdAt: now(), updatedAt: now() }; this.memberships.set(this.memberKey(invite.workspaceId, userId), membership); return membership;
  }
  async updateMember(workspaceId: string, requester: string, targetUserId: string, patch: { role?: Role; status?: 'active' | 'revoked' }): Promise<Membership> {
    await this.requireRole(workspaceId, requester, ['admin']); const member = await this.membership(workspaceId, targetUserId); if (!member) throw new IdentityError('NOT_FOUND', 404, 'Membro não encontrado.');
    const removesAdmin = member.role === 'admin' && (patch.role !== undefined && patch.role !== 'admin' || patch.status === 'revoked');
    if (removesAdmin && this.activeAdminCount(workspaceId) <= 1) throw new IdentityError('LAST_ADMIN_PROTECTED', 409, 'O último administrador ativo não pode ser removido ou rebaixado.');
    if (patch.role) member.role = patch.role; if (patch.status) member.status = patch.status; member.updatedAt = now(); return member;
  }
  async registerAsset(workspaceId: string, userId: string, value: Omit<Asset, 'state' | 'uploadId' | 'createdAt' | 'updatedAt'>): Promise<AssetUpload> {
    await this.requireRole(workspaceId, userId, ['editor', 'admin']); if (value.workspaceId !== workspaceId) throw new IdentityError('WORKSPACE_MISMATCH', 400, 'Arquivo pertence a outro espaço.');
    const existing = this.assets.get(value.id); if (existing && existing.workspaceId !== workspaceId) throw new IdentityError('NOT_FOUND', 404, 'Arquivo não encontrado.');
    if (existing?.state === 'ready' && existing.sha256 === value.sha256) return this.received(existing);
    // Envio em andamento do mesmo conteúdo: a tentativa e as partes já recebidas continuam valendo.
    if (existing?.state === 'pending' && existing.sha256 === value.sha256 && existing.byteSize === value.byteSize) return this.received(existing);
    // O ID do arquivo é gerado no dispositivo e é o que os arranjos referenciam (planejamento/11 e 12):
    // quando os mesmos bytes já estão publicados no espaço sob outro ID, este ID passa a apontar para
    // eles, sem novo upload. Devolver o ID alheio deixaria a referência do arranjo sem download possível.
    const duplicate = [...this.assets.values()].find((asset) => asset.workspaceId === workspaceId && asset.sha256 === value.sha256 && asset.state === 'ready' && asset.byteSize === value.byteSize);
    if (duplicate && !existing) { const alias: Asset = { ...value, state: 'ready', uploadId: randomUUID(), createdAt: now(), updatedAt: now() }; this.assets.set(alias.id, alias); this.bytes.set(alias.id, this.bytes.get(duplicate.id) ?? Buffer.alloc(0)); return this.received(alias); }
    if (existing) { Object.assign(existing, value); existing.state = 'pending'; existing.uploadId = randomUUID(); existing.updatedAt = now(); this.partial.delete(existing.id); return this.received(existing); }
    const asset: Asset = { ...value, state: 'pending', uploadId: randomUUID(), createdAt: now(), updatedAt: now() }; this.assets.set(asset.id, asset); return this.received(asset);
  }
  async getAsset(workspaceId: string, userId: string, assetId: string): Promise<Asset> { await this.requireRole(workspaceId, userId, ROLES); const asset = this.assets.get(assetId); if (!asset || asset.workspaceId !== workspaceId) throw new IdentityError('NOT_FOUND', 404, 'Arquivo não encontrado.'); return asset; }
  async upload(workspaceId: string, userId: string, assetId: string, uploadId: string | undefined, data: Buffer, contentType: string | undefined): Promise<Asset> {
    await this.requireRole(workspaceId, userId, ['editor', 'admin']); const asset = await this.getAsset(workspaceId, userId, assetId);
    if (asset.state === 'ready') { if (asset.sha256 === sha(data)) return asset; throw new IdentityError('IDEMPOTENCY_KEY_REUSED', 409, 'O arquivo já foi publicado com outro conteúdo.'); }
    if (!uploadId || uploadId !== asset.uploadId) throw new IdentityError('UPLOAD_ATTEMPT_INVALID', 409, 'Tentativa de upload inválida; registre o arquivo novamente.');
    if (data.length !== asset.byteSize) { asset.state = 'failed'; throw new IdentityError('ASSET_SIZE_MISMATCH', 400, 'Tamanho do arquivo não confere.'); }
    if (sha(data) !== asset.sha256) { asset.state = 'failed'; throw new IdentityError('ASSET_CHECKSUM_MISMATCH', 400, 'Checksum do arquivo não confere.'); }
    if (contentType && contentType.split(';')[0] !== asset.mimeType || !hasAudioMagic(data, asset.mimeType)) { asset.state = 'failed'; throw new IdentityError('ASSET_TYPE_UNSUPPORTED', 415, 'O conteúdo não é o áudio declarado.'); }
    this.bytes.set(asset.id, Buffer.from(data)); this.partial.delete(asset.id); asset.state = 'ready'; asset.updatedAt = now(); return asset;
  }
  async uploadChunk(workspaceId: string, userId: string, assetId: string, uploadId: string | undefined, offset: number, data: Buffer, contentType: string | undefined): Promise<AssetUpload> {
    await this.requireRole(workspaceId, userId, ['editor', 'admin']); const asset = await this.getAsset(workspaceId, userId, assetId);
    // Resposta da última parte perdida: o arquivo já está publicado e a repetição só confirma.
    if (asset.state === 'ready') return this.received(asset);
    if (!uploadId || uploadId !== asset.uploadId) throw new IdentityError('UPLOAD_ATTEMPT_INVALID', 409, 'Tentativa de upload inválida; registre o arquivo novamente.');
    const stored = this.partial.get(asset.id) ?? Buffer.alloc(0);
    if (offset !== stored.length) throw new IdentityError('UPLOAD_OFFSET_MISMATCH', 409, 'O envio deve continuar de onde parou.', { receivedBytes: stored.length });
    const fail = (code: string, status: number, message: string): never => { this.partial.delete(asset.id); asset.state = 'failed'; throw new IdentityError(code, status, message); };
    if (data.length === 0 || stored.length + data.length > asset.byteSize) fail('ASSET_SIZE_MISMATCH', 400, 'Tamanho do arquivo não confere.');
    const all = Buffer.concat([stored, data]);
    if (all.length < asset.byteSize) { this.partial.set(asset.id, all); return this.received(asset); }
    if (sha(all) !== asset.sha256) fail('ASSET_CHECKSUM_MISMATCH', 400, 'Checksum do arquivo não confere.');
    if (contentType && contentType.split(';')[0] !== asset.mimeType || !hasAudioMagic(all, asset.mimeType)) fail('ASSET_TYPE_UNSUPPORTED', 415, 'O conteúdo não é o áudio declarado.');
    this.bytes.set(asset.id, all); this.partial.delete(asset.id); asset.state = 'ready'; asset.updatedAt = now(); return this.received(asset);
  }
  async content(workspaceId: string, userId: string, assetId: string): Promise<Buffer> { const asset = await this.getAsset(workspaceId, userId, assetId); if (asset.state !== 'ready') throw new IdentityError('DEPENDENCY_NOT_READY', 422, 'Arquivo ainda não está disponível.'); return Buffer.from(this.bytes.get(asset.id) ?? Buffer.alloc(0)); }
  async deleteAsset(workspaceId: string, userId: string, assetId: string): Promise<void> { await this.requireRole(workspaceId, userId, ['editor', 'admin']); await this.getAsset(workspaceId, userId, assetId); this.assets.delete(assetId); this.bytes.delete(assetId); this.partial.delete(assetId); }
  async recoverPartialUploads(): Promise<number> { let count = 0; for (const asset of this.assets.values()) if (asset.state === 'pending') { this.bytes.delete(asset.id); this.partial.delete(asset.id); asset.uploadId = randomUUID(); asset.updatedAt = now(); count++; } return count; }
  private issueAccess(sessionId: string) { const token = randomBytes(32).toString('base64url'); this.access.set(token, { sessionId, expiresAt: Date.now() + 15 * 60_000 }); return token; }
  private revokeFamily(familyId: string) { for (const session of this.sessions.values()) if (session.familyId === familyId) session.revokedAt = Date.now(); }
  private requireUser(id: string) { const user = this.users.get(id); if (!user) throw new IdentityError('UNAUTHORIZED', 401, 'Não autenticado.'); return user; }
  private memberKey(workspaceId: string, userId: string) { return `${workspaceId}:${userId}`; }
  private activeAdminCount(workspaceId: string) { return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId && m.status === 'active' && m.role === 'admin').length; }
}
const hashPassword = (password: string) => { const salt = randomBytes(16); return `${salt.toString('base64url')}:${scryptSync(password, salt, 64).toString('base64url')}`; };
const verifyPassword = (password: string, encoded: string) => { const [salt, digest] = encoded.split(':'); if (!salt || !digest) return false; return safeEquals(scryptSync(password, Buffer.from(salt, 'base64url'), 64).toString('base64url'), digest); };
const safeEquals = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const hasAudioMagic = (data: Buffer, type: string) => sniffAudioType(data.subarray(0, 12)) === type;
