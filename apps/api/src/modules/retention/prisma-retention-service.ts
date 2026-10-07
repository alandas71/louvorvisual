import type { PrismaClient } from '@prisma/client';

export type RetentionPolicy = {
  trashDays: number;
  syncDays: number;
  sessionDays: number;
};

export type RetentionResult = {
  expiredSessions: number;
  expiredInvitations: number;
  expiredSnapshots: number;
  expiredDevices: number;
  expiredOperations: number;
  expiredEvents: number;
  expiredRevisions: number;
  expiredTombstones: number;
};

const daysAgo = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000);

/**
 * Só remove histórico depois da janela de reconciliação. Ao apagar eventos, avança
 * minCursor na mesma transação: clientes antigos recebem CURSOR_EXPIRED e fazem
 * bootstrap em vez de receber uma sequência parcial.
 */
export class PrismaRetentionService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(policy: RetentionPolicy, now = new Date()): Promise<RetentionResult> {
    const syncBefore = daysAgo(policy.syncDays, now);
    const sessionBefore = daysAgo(policy.sessionDays, now);
    // A lixeira pode sumir da interface após trashDays, mas o tombstone precisa
    // sobreviver à maior janela para que dispositivos offline não o ressuscitem.
    const tombstoneBefore = daysAgo(Math.max(policy.trashDays, policy.syncDays), now);
    const result: RetentionResult = { expiredSessions: 0, expiredInvitations: 0, expiredSnapshots: 0, expiredDevices: 0, expiredOperations: 0, expiredEvents: 0, expiredRevisions: 0, expiredTombstones: 0 };
    result.expiredSessions = (await this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: sessionBefore } }] } })).count;
    result.expiredInvitations = (await this.prisma.invitation.deleteMany({ where: { expiresAt: { lt: now }, acceptedAt: null } })).count;
    result.expiredSnapshots = (await this.prisma.syncBootstrapSnapshot.deleteMany({ where: { expiresAt: { lt: now } } })).count;
    result.expiredDevices = (await this.prisma.device.deleteMany({ where: { lastSeenAt: { lt: syncBefore } } })).count;
    result.expiredOperations = (await this.prisma.processedOperation.deleteMany({ where: { createdAt: { lt: syncBefore } } })).count;

    const workspaces = await this.prisma.workspaceSyncClock.findMany({ select: { workspaceId: true, minCursor: true } });
    for (const clock of workspaces) {
      const pruned = await this.prisma.$transaction(async (tx) => {
        const last = await tx.changeEvent.findFirst({ where: { workspaceId: clock.workspaceId, createdAt: { lt: syncBefore } }, orderBy: { cursor: 'desc' }, select: { cursor: true } });
        if (!last) return { events: 0, revisions: 0, tombstones: 0 };
        const cursor = last.cursor > clock.minCursor ? last.cursor : clock.minCursor;
        const events = await tx.changeEvent.deleteMany({ where: { workspaceId: clock.workspaceId, cursor: { lte: cursor } } });
        const revisions = await tx.contentRevision.deleteMany({ where: { workspaceId: clock.workspaceId, createdAt: { lt: syncBefore } } });
        // Uma exclusão continua sincronizável até o mesmo limite dos eventos. Só
        // então o agregado tombstone pode sair; retired_entity_ids preserva o ID.
        const tombstones = await tx.contentEntity.deleteMany({ where: { workspaceId: clock.workspaceId, deletedAt: { lt: tombstoneBefore } } });
        await tx.workspaceSyncClock.update({ where: { workspaceId: clock.workspaceId }, data: { minCursor: cursor } });
        return { events: events.count, revisions: revisions.count, tombstones: tombstones.count };
      });
      result.expiredEvents += pruned.events; result.expiredRevisions += pruned.revisions; result.expiredTombstones += pruned.tombstones;
    }
    return result;
  }
}
