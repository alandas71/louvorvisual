#!/usr/bin/env bash
set -euo pipefail

# Restaura somente em banco isolado e descartável.
: "${LOUVORVISUAL_MYSQL_HOST:?defina LOUVORVISUAL_MYSQL_HOST}"
: "${LOUVORVISUAL_MYSQL_USER:?defina LOUVORVISUAL_MYSQL_USER}"
: "${LOUVORVISUAL_MYSQL_DATABASE:?defina LOUVORVISUAL_MYSQL_DATABASE}"
: "${LOUVORVISUAL_RESTORE_DATABASE:?defina LOUVORVISUAL_RESTORE_DATABASE}"
: "${LOUVORVISUAL_BACKUP_FILE:?defina LOUVORVISUAL_BACKUP_FILE}"
[[ "$LOUVORVISUAL_RESTORE_DATABASE" != "${LOUVORVISUAL_MYSQL_DATABASE:-}" ]] || { echo 'Destino de restore não pode ser o banco primário.' >&2; exit 2; }
mysql_args=(-h "$LOUVORVISUAL_MYSQL_HOST" -u "$LOUVORVISUAL_MYSQL_USER")
[[ -n "${LOUVORVISUAL_MYSQL_PORT:-}" ]] && mysql_args+=(-P "$LOUVORVISUAL_MYSQL_PORT")
gzip -t "$LOUVORVISUAL_BACKUP_FILE"
mysql "${mysql_args[@]}" -e "CREATE DATABASE \`$LOUVORVISUAL_RESTORE_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$LOUVORVISUAL_BACKUP_FILE" | sed "s/\`$LOUVORVISUAL_MYSQL_DATABASE\`/\`$LOUVORVISUAL_RESTORE_DATABASE\`/g" | mysql "${mysql_args[@]}"
mysql "${mysql_args[@]}" -D "$LOUVORVISUAL_RESTORE_DATABASE" -e 'SELECT DATABASE() AS restoredDatabase, (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM assets) AS assets;'
printf 'restore_database=%s\nsource_backup=%s\nresult=restored-and-queried\n' "$LOUVORVISUAL_RESTORE_DATABASE" "$LOUVORVISUAL_BACKUP_FILE"
