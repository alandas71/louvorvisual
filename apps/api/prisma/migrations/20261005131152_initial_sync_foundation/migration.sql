BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[workspaces] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(200) NOT NULL,
    [timezone] VARCHAR(64) NOT NULL CONSTRAINT [workspaces_timezone_df] DEFAULT 'UTC',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [workspaces_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [workspaces_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[workspace_sync_clocks] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [nextCursor] BIGINT NOT NULL CONSTRAINT [workspace_sync_clocks_nextCursor_df] DEFAULT 0,
    CONSTRAINT [workspace_sync_clocks_pkey] PRIMARY KEY CLUSTERED ([workspaceId])
);

-- CreateTable
CREATE TABLE [dbo].[content_entities] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [entityType] VARCHAR(20) NOT NULL,
    [entityId] UNIQUEIDENTIFIER NOT NULL,
    [currentRevision] BIGINT NOT NULL,
    [documentJson] NVARCHAR(max) NOT NULL,
    [deletedAt] DATETIME2,
    [updatedAt] DATETIME2 NOT NULL CONSTRAINT [content_entities_updatedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [content_entities_pkey] PRIMARY KEY CLUSTERED ([workspaceId],[entityType],[entityId])
);

-- CreateTable
CREATE TABLE [dbo].[content_revisions] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [entityType] VARCHAR(20) NOT NULL,
    [entityId] UNIQUEIDENTIFIER NOT NULL,
    [revision] BIGINT NOT NULL,
    [documentJson] NVARCHAR(max) NOT NULL,
    [action] VARCHAR(10) NOT NULL,
    [actorId] UNIQUEIDENTIFIER NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [content_revisions_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [content_revisions_pkey] PRIMARY KEY CLUSTERED ([workspaceId],[entityType],[entityId],[revision])
);

-- CreateTable
CREATE TABLE [dbo].[change_events] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [cursor] BIGINT NOT NULL,
    [entityType] VARCHAR(20) NOT NULL,
    [entityId] UNIQUEIDENTIFIER NOT NULL,
    [revision] BIGINT NOT NULL,
    [action] VARCHAR(10) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [change_events_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [change_events_pkey] PRIMARY KEY CLUSTERED ([workspaceId],[cursor])
);

-- CreateTable
CREATE TABLE [dbo].[processed_operations] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [opId] UNIQUEIDENTIFIER NOT NULL,
    [actorId] UNIQUEIDENTIFIER NOT NULL,
    [payloadHash] CHAR(64) NOT NULL,
    [resultJson] NVARCHAR(max) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [processed_operations_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [processed_operations_pkey] PRIMARY KEY CLUSTERED ([workspaceId],[opId])
);

-- CreateTable
CREATE TABLE [dbo].[retired_entity_ids] (
    [workspaceId] UNIQUEIDENTIFIER NOT NULL,
    [entityType] VARCHAR(20) NOT NULL,
    [entityId] UNIQUEIDENTIFIER NOT NULL,
    [retiredAt] DATETIME2 NOT NULL CONSTRAINT [retired_entity_ids_retiredAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [retired_entity_ids_pkey] PRIMARY KEY CLUSTERED ([workspaceId],[entityType],[entityId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [content_entities_workspaceId_deletedAt_updatedAt_idx] ON [dbo].[content_entities]([workspaceId], [deletedAt], [updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [change_events_workspaceId_cursor_idx] ON [dbo].[change_events]([workspaceId], [cursor]);

-- AddForeignKey
ALTER TABLE [dbo].[workspace_sync_clocks] ADD CONSTRAINT [workspace_sync_clocks_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [dbo].[workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[content_entities] ADD CONSTRAINT [content_entities_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [dbo].[workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[content_revisions] ADD CONSTRAINT [content_revisions_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [dbo].[workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[change_events] ADD CONSTRAINT [change_events_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [dbo].[workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[processed_operations] ADD CONSTRAINT [processed_operations_workspaceId_fkey] FOREIGN KEY ([workspaceId]) REFERENCES [dbo].[workspaces]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
