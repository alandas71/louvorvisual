ALTER TABLE [workspace_sync_clocks] ADD [minCursor] BIGINT NOT NULL CONSTRAINT [workspace_sync_clocks_minCursor_df] DEFAULT 0;

CREATE TABLE [devices] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [userId] UNIQUEIDENTIFIER NOT NULL,
    [lastSeenAt] DATETIME2 NOT NULL CONSTRAINT [devices_lastSeenAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [devices_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [devices_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE
);
CREATE INDEX [devices_workspaceId_userId_lastSeenAt_idx] ON [devices]([workspaceId], [userId], [lastSeenAt]);

CREATE TABLE [sync_bootstrap_snapshots] (
    [token] UNIQUEIDENTIFIER NOT NULL,
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [accessRevision] BIGINT NOT NULL CONSTRAINT [sync_bootstrap_snapshots_accessRevision_df] DEFAULT 0,
    [cutCursor] BIGINT NOT NULL,
    [documentsJson] NVARCHAR(max) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [sync_bootstrap_snapshots_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [sync_bootstrap_snapshots_pkey] PRIMARY KEY CLUSTERED ([token]),
    CONSTRAINT [sync_bootstrap_snapshots_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE
);
CREATE INDEX [sync_bootstrap_snapshots_workspaceId_expiresAt_idx] ON [sync_bootstrap_snapshots]([workspaceId], [expiresAt]);
