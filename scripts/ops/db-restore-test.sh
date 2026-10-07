#!/usr/bin/env bash
set -euo pipefail

# Restaura somente em banco isolado. O destino deve ser novo e descartável.
: "${LOUVORVISUAL_SQL_SERVER:?defina LOUVORVISUAL_SQL_SERVER}"
: "${LOUVORVISUAL_RESTORE_DATABASE:?defina LOUVORVISUAL_RESTORE_DATABASE}"
: "${LOUVORVISUAL_BACKUP_FILE:?defina LOUVORVISUAL_BACKUP_FILE}"
: "${LOUVORVISUAL_RESTORE_DATA_DIR:?defina LOUVORVISUAL_RESTORE_DATA_DIR (diretório do servidor SQL)}"
: "${LOUVORVISUAL_RESTORE_LOGICAL_DATA:?defina o nome lógico de dados do backup}"
: "${LOUVORVISUAL_RESTORE_LOGICAL_LOG:?defina o nome lógico de log do backup}"
sql_user_args=()
if [[ -n "${LOUVORVISUAL_SQL_USER:-}" ]]; then sql_user_args=(-U "$LOUVORVISUAL_SQL_USER"); else sql_user_args=(-E); fi
[[ "$LOUVORVISUAL_RESTORE_DATABASE" != "${LOUVORVISUAL_SQL_DATABASE:-}" ]] || { echo 'Destino de restore não pode ser o banco primário.' >&2; exit 2; }
sqlcmd -S "$LOUVORVISUAL_SQL_SERVER" "${sql_user_args[@]}" -d master -b -Q "RESTORE VERIFYONLY FROM DISK = N'$LOUVORVISUAL_BACKUP_FILE' WITH CHECKSUM"
sqlcmd -S "$LOUVORVISUAL_SQL_SERVER" "${sql_user_args[@]}" -d master -b -Q "RESTORE DATABASE [$LOUVORVISUAL_RESTORE_DATABASE] FROM DISK = N'$LOUVORVISUAL_BACKUP_FILE' WITH MOVE N'$LOUVORVISUAL_RESTORE_LOGICAL_DATA' TO N'${LOUVORVISUAL_RESTORE_DATA_DIR%/}/$LOUVORVISUAL_RESTORE_DATABASE.mdf', MOVE N'$LOUVORVISUAL_RESTORE_LOGICAL_LOG' TO N'${LOUVORVISUAL_RESTORE_DATA_DIR%/}/$LOUVORVISUAL_RESTORE_DATABASE.ldf', RECOVERY, CHECKSUM, STATS = 10"
sqlcmd -S "$LOUVORVISUAL_SQL_SERVER" "${sql_user_args[@]}" -d "$LOUVORVISUAL_RESTORE_DATABASE" -b -Q "SET NOCOUNT ON; SELECT DB_NAME() AS restoredDatabase, COUNT(*) AS workspaces FROM dbo.workspaces; SELECT COUNT(*) AS assets FROM dbo.assets;"
printf 'restore_database=%s\nsource_backup=%s\nresult=restored-and-queried\n' "$LOUVORVISUAL_RESTORE_DATABASE" "$LOUVORVISUAL_BACKUP_FILE"
