'use client';

import { TransportError } from '@louvorvisual/sync';
import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { LocalDatabase } from '@/local/db';
import type { LocalSession } from '@/local/session';
import { accountApi, currentAccount, type Me, type Member } from '@/sync/api';
import type { SyncEngine } from '@/sync/engine';
import { buildPendingExport, downloadJson } from '@/sync/exportPending';
import { useSyncEngine, useSyncStatus } from '@/sync/hooks';
import { activateProfile, activateTeamProfile, listTeamProfiles, removeTeamProfile, type AccountWorkspace, type TeamProfile, type TeamRole } from '@/sync/profiles';

const sectionClass = 'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-5';
const ROLE_TEXT: Record<TeamRole, string> = { operator: 'Operador', editor: 'Editor', admin: 'Administrador' };

type Account = { state: 'loading' } | { state: 'unreachable' } | { state: 'signed-out' } | { state: 'signed-in'; me: Me };

function errorText(error: unknown): string {
  if (error instanceof TransportError) return error.kind === 'network' ? 'Sem conexão com o servidor. Tente de novo quando houver internet.' : error.message;
  return 'Não foi possível concluir.';
}

/** Trocar de perfil recarrega a página: nenhum dado do perfil anterior fica em memória. */
function reloadApp(): void {
  window.location.search = '?view=conta';
}

async function loadAccount(): Promise<{ profiles: TeamProfile[]; account: Account }> {
  const profiles = await listTeamProfiles().catch(() => []);
  try {
    const me = await currentAccount();
    return { profiles, account: me ? { state: 'signed-in', me } : { state: 'signed-out' } };
  } catch {
    return { profiles, account: { state: 'unreachable' } };
  }
}

export function AccountView() {
  const current = useSyncEngine();
  if (!current) return <p role="status">Abrindo os dados deste dispositivo…</p>;
  return <Account session={current.session} engine={current.engine} />;
}

function Account({ session, engine }: { session: LocalSession; engine: SyncEngine }) {
  const [account, setAccount] = useState<Account>({ state: 'loading' });
  const [profiles, setProfiles] = useState<TeamProfile[]>([]);
  const status = useSyncStatus(engine);
  const { team } = session;

  const refresh = useCallback(
    () =>
      loadAccount().then((loaded) => {
        setProfiles(loaded.profiles);
        setAccount(loaded.account);
      }),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-8" data-testid="account-view">
      <header>
        <h1 className="text-2xl font-bold">Conta e equipe</h1>
        <p className="mt-1 text-muted">Entrar, escolher a equipe e gerenciar os perfis guardados neste dispositivo. Tudo aqui precisa de conexão; a biblioteca aberta continua funcionando sem ela.</p>
      </header>

      <section aria-labelledby="perfil-em-uso" className={sectionClass}>
        <h2 id="perfil-em-uso" className="text-lg font-semibold">
          Perfil em uso neste dispositivo
        </h2>
        <p data-testid="active-profile" data-kind={team ? 'team' : 'personal'} data-profile-id={session.profile.profileId} data-workspace-id={session.profile.workspaceId} data-user-id={session.profile.userId} data-role={team?.role}>
          {team ? (
            <>
              Equipe <strong>{team.workspaceName}</strong>, conta {team.userName} ({team.userEmail}). Papel conhecido: {ROLE_TEXT[team.role]}.
            </>
          ) : (
            <>
              <strong>Perfil pessoal</strong>: biblioteca só deste dispositivo, nunca enviada a um servidor.
            </>
          )}
        </p>
        {team && <p className="text-xs text-muted">O papel mostrado é o da última vez online; quem decide o que você pode publicar é sempre o servidor.</p>}
      </section>

      {account.state === 'loading' && <p role="status">Consultando a sessão…</p>}
      {account.state === 'unreachable' && (
        <p role="status" data-testid="account-state" data-state="unreachable" className={sectionClass}>
          Sem conexão com o servidor de contas. O perfil aberto continua disponível neste dispositivo; entrar, sair e gerenciar a equipe exigem conexão.
        </p>
      )}
      {account.state === 'signed-out' && <SignIn session={session} onDone={refresh} />}
      {account.state === 'signed-in' && <SignedIn session={session} engine={engine} me={account.me} pending={status.summary?.pending ?? 0} onChange={refresh} />}

      <Profiles session={session} profiles={profiles} onChange={refresh} />
    </div>
  );
}

function SignIn({ session, onDone }: { session: LocalSession; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { user } = mode === 'login' ? await accountApi.login({ email, password }) : await accountApi.register({ name, email, password });
      // Outra conta entrou: o perfil anterior deixa de ser carregado automaticamente.
      if (session.team && session.team.userId !== user.id) {
        await activateProfile(null);
        reloadApp();
        return;
      }
      await onDone();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="entrar" className={sectionClass}>
      <h2 id="entrar" className="text-lg font-semibold">
        {mode === 'login' ? 'Entrar' : 'Criar conta'}
      </h2>
      <p data-testid="account-state" data-state="signed-out" className="text-sm text-muted">
        Nenhuma conta conectada. Criar uma conta não envia a biblioteca pessoal deste dispositivo.
      </p>
      <form
        className="flex max-w-md flex-col gap-3"
        data-testid="auth-form"
        data-mode={mode}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === 'register' && (
          <div>
            <Label htmlFor="conta-nome">Nome</Label>
            <Input id="conta-nome" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
          </div>
        )}
        <div>
          <Label htmlFor="conta-email">E-mail</Label>
          <Input id="conta-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </div>
        <div>
          <Label htmlFor="conta-senha">Senha (12 caracteres ou mais)</Label>
          <Input id="conta-senha" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={12} required />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="auth-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={buttonClass('primary')} disabled={busy}>
            {mode === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
          <button type="button" className={buttonClass('secondary')} onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Quero criar uma conta' : 'Já tenho conta'}
          </button>
        </div>
      </form>
    </section>
  );
}

type SignedInProps = { session: LocalSession; engine: SyncEngine; me: Me; pending: number; onChange: () => Promise<void> };

function SignedIn({ session, engine, me, pending, onChange }: SignedInProps) {
  const [teamName, setTeamName] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const { team } = session;
  const mismatch = team !== null && team.userId !== me.user.id;

  async function guard(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function use(workspace: AccountWorkspace) {
    await activateTeamProfile(me.user, workspace);
    reloadApp();
  }

  async function logout(removeLocal: boolean) {
    await guard(async () => {
      await accountApi.logout();
      if (removeLocal && team) {
        session.db.close();
        await removeTeamProfile(team.profileId);
        reloadApp();
        return;
      }
      await onChange();
      engine.syncNow();
    });
  }

  return (
    <>
      <section aria-labelledby="conta" className={sectionClass}>
        <h2 id="conta" className="text-lg font-semibold">
          Conta conectada
        </h2>
        <p data-testid="account-state" data-state="signed-in" data-user-id={me.user.id}>
          {me.user.name} ({me.user.email})
        </p>
        {mismatch && (
          <p role="alert" data-testid="account-mismatch" className="rounded-lg border border-danger p-3 text-sm">
            O perfil aberto pertence a {team?.userEmail}. Enquanto esta outra conta estiver conectada, nada daquele perfil é enviado. Escolha abaixo uma equipe desta conta ou saia e entre com a conta do perfil.
          </p>
        )}
        {leaving ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border-strong p-4 text-sm" data-testid="logout-options">
            <p>
              Sair encerra a sessão online. {team && !mismatch && pending > 0 ? `Este perfil tem ${pending} ${pending === 1 ? 'alteração pendente' : 'alterações pendentes'} que ainda não chegaram à equipe.` : ''}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={buttonClass('secondary')} data-action="logout-keep" onClick={() => void logout(false)}>
                Sair e manter este perfil neste computador
              </button>
              {team && !mismatch && (
                <>
                  {pending > 0 && (
                    <button type="button" className={buttonClass('secondary')} onClick={() => void buildPendingExport(session, engine.storage).then((data) => downloadJson('louvorvisual-pendencias.json', data))}>
                      Exportar pendências antes
                    </button>
                  )}
                  <button type="button" className={buttonClass('danger')} data-action="logout-remove" onClick={() => void logout(true)}>
                    Sair e remover os dados locais deste perfil{pending > 0 ? ` (perde ${pending} pendência${pending === 1 ? '' : 's'})` : ''}
                  </button>
                </>
              )}
              <button type="button" className={buttonClass('secondary')} onClick={() => setLeaving(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={buttonClass('secondary', 'md', 'self-start')} data-testid="logout" onClick={() => setLeaving(true)}>
            Sair
          </button>
        )}
      </section>

      <section aria-labelledby="equipes" className={sectionClass}>
        <h2 id="equipes" className="text-lg font-semibold">
          Equipes desta conta
        </h2>
        {me.workspaces.length === 0 ? (
          <p className="text-muted" data-testid="workspaces-empty">
            Esta conta ainda não participa de nenhuma equipe. Crie uma ou aceite um convite.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {me.workspaces.map((workspace) => {
              const active = team?.workspaceId === workspace.id && !mismatch;
              return (
                <li key={workspace.id} data-testid="workspace-row" data-workspace-id={workspace.id} data-role={workspace.role} data-active={active} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <span>
                    <strong>{workspace.name}</strong> · {ROLE_TEXT[workspace.role]}
                  </span>
                  {active ? (
                    <span className="text-sm text-muted">Em uso neste dispositivo</span>
                  ) : (
                    <button type="button" className={buttonClass('primary', 'sm')} onClick={() => void guard(() => use(workspace))}>
                      Usar neste dispositivo
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          data-testid="create-workspace"
          onSubmit={(event) => {
            event.preventDefault();
            void guard(async () => {
              const created = await accountApi.createWorkspace(teamName, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
              setTeamName('');
              await use({ id: created.id, name: created.name, role: 'admin' });
            });
          }}
        >
          <div className="min-w-56 flex-1">
            <Label htmlFor="equipe-nome">Nova equipe</Label>
            <Input id="equipe-nome" value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Ex.: Louvor da Vila" required />
          </div>
          <button type="submit" className={buttonClass('secondary')}>
            Criar e usar
          </button>
        </form>
        <form
          className="flex flex-wrap items-end gap-3"
          data-testid="accept-invitation"
          onSubmit={(event) => {
            event.preventDefault();
            void guard(async () => {
              await accountApi.acceptInvitation(inviteToken.trim());
              setInviteToken('');
              await onChange();
            });
          }}
        >
          <div className="min-w-56 flex-1">
            <Label htmlFor="convite-token">Código de convite</Label>
            <Input id="convite-token" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} required />
          </div>
          <button type="submit" className={buttonClass('secondary')}>
            Aceitar convite
          </button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="account-error">
            {error}
          </p>
        )}
      </section>

      {team && !mismatch && team.role === 'admin' && <Members team={team} me={me} />}
    </>
  );
}

function Members({ team, me }: { team: TeamProfile; me: Me }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('editor');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => accountApi.members(team.workspaceId).then(setMembers, (reason) => setError(errorText(reason))), [team.workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function guard(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  return (
    <section aria-labelledby="membros" className={sectionClass} data-testid="members">
      <h2 id="membros" className="text-lg font-semibold">
        Membros de {team.workspaceName}
      </h2>
      <p className="text-sm text-muted">Mudança de papel e revogação valem no servidor na hora. Um dispositivo desconectado só fica sabendo quando reconectar, e o que ele já baixou não é apagado à distância.</p>
      {members === null ? (
        <p role="status">Carregando membros…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <li key={member.userId} data-testid="member-row" data-user-id={member.userId} data-email={member.user.email} data-role={member.role} data-status={member.status} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <span>
                <strong>{member.user.name}</strong> ({member.user.email}){member.status === 'revoked' && <span className="ml-2 text-danger">acesso revogado</span>}
              </span>
              {member.userId !== me.user.id && (
                <span className="flex flex-wrap items-center gap-2">
                  <Select aria-label={`Papel de ${member.user.name}`} value={member.role} onChange={(event) => void guard(() => accountApi.updateMember(team.workspaceId, member.userId, { role: event.target.value as TeamRole }))} className="py-1.5">
                    {(Object.keys(ROLE_TEXT) as TeamRole[]).map((value) => (
                      <option key={value} value={value}>
                        {ROLE_TEXT[value]}
                      </option>
                    ))}
                  </Select>
                  <button type="button" className={buttonClass(member.status === 'active' ? 'danger' : 'secondary', 'sm')} data-action={member.status === 'active' ? 'revoke' : 'restore'} onClick={() => void guard(() => accountApi.updateMember(team.workspaceId, member.userId, { status: member.status === 'active' ? 'revoked' : 'active' }))}>
                    {member.status === 'active' ? 'Revogar acesso' : 'Devolver acesso'}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        data-testid="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          void guard(async () => {
            setToken((await accountApi.invite(team.workspaceId, email, role)).token);
            setEmail('');
          });
        }}
      >
        <div className="min-w-56 flex-1">
          <Label htmlFor="convite-email">Convidar por e-mail</Label>
          <Input id="convite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="w-44">
          <Label htmlFor="convite-papel">Papel</Label>
          <Select id="convite-papel" value={role} onChange={(event) => setRole(event.target.value as TeamRole)}>
            {(Object.keys(ROLE_TEXT) as TeamRole[]).map((value) => (
              <option key={value} value={value}>
                {ROLE_TEXT[value]}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Gerar convite
        </button>
      </form>
      {token && (
        <p className="break-all text-sm" data-testid="invite-token" data-token={token}>
          Código de convite (uso único, válido por 7 dias, só para o e-mail informado): <code>{token}</code>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="members-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Pendências de um perfil que não está aberto, lidas direto do banco dele. */
async function pendingOf(profile: TeamProfile): Promise<number> {
  const db = new LocalDatabase(profile.dbName);
  try {
    return await db.entityStates.where('[workspaceId+dirty]').equals([profile.workspaceId, 1]).count();
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function Profiles({ session, profiles, onChange }: { session: LocalSession; profiles: TeamProfile[]; onChange: () => Promise<void> }) {
  const [pending, setPending] = useState<Record<string, number>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const activeId = session.team?.profileId ?? null;

  useEffect(() => {
    let current = true;
    // O perfil aberto já tem a contagem no estado da sincronização; aqui só os fechados.
    void Promise.all(profiles.filter((profile) => profile.profileId !== activeId).map(async (profile) => [profile.profileId, await pendingOf(profile)] as const)).then((entries) => current && setPending(Object.fromEntries(entries)));
    return () => {
      current = false;
    };
  }, [profiles, activeId]);

  async function open(profileId: string | null) {
    await activateProfile(profileId);
    reloadApp();
  }

  return (
    <section aria-labelledby="perfis" className={sectionClass} data-testid="profiles">
      <h2 id="perfis" className="text-lg font-semibold">
        Perfis guardados neste dispositivo
      </h2>
      <p className="text-sm text-muted">Cada perfil tem biblioteca, áudio, fila de envio e conflitos próprios. Trocar de perfil não mistura nada. Os dados ficam no navegador, sem criptografia: quem usa este usuário do computador pode abri-los.</p>
      <ul className="flex flex-col gap-2">
        <li data-testid="profile-row" data-kind="personal" data-active={activeId === null} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <span>
            <strong>Perfil pessoal</strong> · só neste dispositivo
          </span>
          {activeId === null ? (
            <span className="text-muted">Em uso</span>
          ) : (
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => void open(null)}>
              Abrir
            </button>
          )}
        </li>
        {profiles.map((profile) => (
          <li key={profile.profileId} data-testid="profile-row" data-kind="team" data-profile-id={profile.profileId} data-workspace-id={profile.workspaceId} data-user-id={profile.userId} data-active={profile.profileId === activeId} className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                <strong>{profile.workspaceName}</strong> · {profile.userName} ({profile.userEmail})
                {(pending[profile.profileId] ?? 0) > 0 && <span className="ml-2 text-muted">{pending[profile.profileId]} pendente(s)</span>}
              </span>
              <span className="flex flex-wrap gap-2">
                {profile.profileId === activeId ? (
                  <span className="text-muted">Em uso</span>
                ) : (
                  <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => void open(profile.profileId)}>
                    Abrir
                  </button>
                )}
                <button type="button" className={buttonClass('danger', 'sm')} data-action="remove-profile" onClick={() => setRemoving(profile.profileId)}>
                  Remover dados locais
                </button>
              </span>
            </div>
            {removing === profile.profileId && (
              <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger p-3">
                <span>Remove deste dispositivo a biblioteca, o áudio, as sessões e a fila deste perfil. O que não foi enviado é perdido; exporte as pendências antes, em &ldquo;Sincronização&rdquo;. O que já está no servidor não é afetado.</span>
                <button
                  type="button"
                  className={buttonClass('danger', 'sm')}
                  data-action="confirm-remove-profile"
                  onClick={() => {
                    // O banco aberto nesta janela precisa ser fechado antes de ser apagado.
                    if (profile.profileId === activeId) session.db.close();
                    void removeTeamProfile(profile.profileId).then(() => {
                      if (profile.profileId === activeId) reloadApp();
                      else void onChange();
                      setRemoving(null);
                    });
                  }}
                >
                  Remover definitivamente
                </button>
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setRemoving(null)}>
                  Cancelar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
