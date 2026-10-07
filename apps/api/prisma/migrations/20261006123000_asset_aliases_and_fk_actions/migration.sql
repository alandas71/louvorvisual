-- Um mesmo áudio pode ter IDs distintos no mesmo espaço (os arranjos preservam
-- o ID produzido pelo dispositivo). Os bytes são deduplicados por storageKey.
ALTER TABLE [assets] DROP CONSTRAINT [assets_workspaceId_sha256_key];

-- Prisma declara estas ações e bancos existentes precisam da mesma semântica.
ALTER TABLE [memberships] DROP CONSTRAINT [memberships_workspaceId_fkey];
ALTER TABLE [memberships] ADD CONSTRAINT [memberships_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [memberships] DROP CONSTRAINT [memberships_userId_fkey];
ALTER TABLE [memberships] ADD CONSTRAINT [memberships_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [users]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [invitations] DROP CONSTRAINT [invitations_workspaceId_fkey];
ALTER TABLE [invitations] ADD CONSTRAINT [invitations_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [invitations] DROP CONSTRAINT [invitations_recipientUserId_fkey];
ALTER TABLE [invitations] ADD CONSTRAINT [invitations_recipientUserId_fkey] FOREIGN KEY ([recipientUserId]) REFERENCES [users]([id]) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE [sessions] DROP CONSTRAINT [sessions_userId_fkey];
ALTER TABLE [sessions] ADD CONSTRAINT [sessions_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [users]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [assets] DROP CONSTRAINT [assets_workspaceId_fkey];
ALTER TABLE [assets] ADD CONSTRAINT [assets_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [devices] DROP CONSTRAINT [devices_workspaceId_fkey];
ALTER TABLE [devices] ADD CONSTRAINT [devices_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE [sync_bootstrap_snapshots] DROP CONSTRAINT [sync_bootstrap_snapshots_workspaceId_fkey];
ALTER TABLE [sync_bootstrap_snapshots] ADD CONSTRAINT [sync_bootstrap_snapshots_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
