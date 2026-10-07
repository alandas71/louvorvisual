CREATE TABLE [users] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(200) NOT NULL,
    [email] NVARCHAR(320) NOT NULL,
    [passwordHash] NVARCHAR(512) NOT NULL,
    [status] VARCHAR(20) NOT NULL CONSTRAINT [users_status_df] DEFAULT 'active',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [users_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [users_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [users_email_key] UNIQUE NONCLUSTERED ([email])
);

CREATE TABLE [memberships] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [userId] UNIQUEIDENTIFIER NOT NULL,
    [role] VARCHAR(20) NOT NULL,
    [status] VARCHAR(20) NOT NULL CONSTRAINT [memberships_status_df] DEFAULT 'active',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [memberships_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL CONSTRAINT [memberships_updatedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [memberships_pkey] PRIMARY KEY CLUSTERED ([workspaceId], [userId]),
    CONSTRAINT [memberships_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE,
    CONSTRAINT [memberships_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [users]([id]) ON DELETE CASCADE
);
CREATE INDEX [memberships_userId_status_idx] ON [memberships]([userId], [status]);

CREATE TABLE [invitations] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [email] NVARCHAR(320) NOT NULL,
    [role] VARCHAR(20) NOT NULL,
    [tokenHash] CHAR(64) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [acceptedAt] DATETIME2,
    [recipientUserId] UNIQUEIDENTIFIER,
    [createdBy] UNIQUEIDENTIFIER NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [invitations_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [invitations_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [invitations_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash]),
    CONSTRAINT [invitations_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE,
    CONSTRAINT [invitations_recipientUserId_fkey] FOREIGN KEY ([recipientUserId]) REFERENCES [users]([id])
);
CREATE INDEX [invitations_workspaceId_email_idx] ON [invitations]([workspaceId], [email]);

CREATE TABLE [sessions] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [userId] UNIQUEIDENTIFIER NOT NULL,
    [refreshTokenHash] CHAR(64) NOT NULL,
    [familyId] UNIQUEIDENTIFIER NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [revokedAt] DATETIME2,
    [replacedById] UNIQUEIDENTIFIER,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [sessions_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [sessions_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [sessions_refreshTokenHash_key] UNIQUE NONCLUSTERED ([refreshTokenHash]),
    CONSTRAINT [sessions_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [users]([id]) ON DELETE CASCADE
);
CREATE INDEX [sessions_userId_familyId_idx] ON [sessions]([userId], [familyId]);

CREATE TABLE [assets] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [sha256] CHAR(64) NOT NULL,
    [filename] NVARCHAR(255) NOT NULL,
    [mimeType] VARCHAR(64) NOT NULL,
    [byteSize] INT NOT NULL,
    [audioKind] VARCHAR(20) NOT NULL,
    [durationMs] INT,
    [state] VARCHAR(20) NOT NULL,
    [storageKey] NVARCHAR(512),
    [uploadId] UNIQUEIDENTIFIER,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [assets_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL CONSTRAINT [assets_updatedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [assets_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [assets_workspaceId_sha256_key] UNIQUE NONCLUSTERED ([workspaceId], [sha256]),
    CONSTRAINT [assets_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [workspaces]([id]) ON DELETE CASCADE
);
CREATE INDEX [assets_workspaceId_state_idx] ON [assets]([workspaceId], [state]);
