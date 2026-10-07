#!/usr/bin/env bash
set -euo pipefail

# Executar apenas em ambiente protegido, com SQLCMDPASSWORD fornecida pelo cofre
# quando autenticação SQL for usada. Nunca grave a senha no comando ou relatório.
: "${LOUVORVISUAL_SQL_SERVER:?defina LOUVORVISUAL_SQL_SERVER}"
: "${LOUVORVISUAL_SQL_DATABASE:?defina LOUVORVISUAL_SQL_DATABASE}"
: "${LOUVORVISUAL_BACKUP_DIR:?defina LOUVORVISUAL_BACKUP_DIR (volume protegido visível ao job)}"
sql_user_args=()
if [[ -n "${LOUVORVISUAL_SQL_USER:-}" ]]; then sql_user_args=(-U "$LOUVORVISUAL_SQL_USER"); else sql_user_args=(-E); fi
backup_dir="${LOUVORVISUAL_BACKUP_DIR%/}"
server_backup_dir="${LOUVORVISUAL_SQL_BACKUP_DIR:-$backup_dir}"
stamp="${LOUVORVISUAL_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'LOUVORVISUAL_BACKUP_STAMP deve usar YYYYMMDDTHHMMSSZ.' >&2; exit 2; }
backup_file="$backup_dir/${LOUVORVISUAL_SQL_DATABASE}-${stamp}.bak"
server_backup_file="$server_backup_dir/${LOUVORVISUAL_SQL_DATABASE}-${stamp}.bak"

sqlcmd -S "$LOUVORVISUAL_SQL_SERVER" "${sql_user_args[@]}" -d master -b -Q "BACKUP DATABASE [$LOUVORVISUAL_SQL_DATABASE] TO DISK = N'$server_backup_file' WITH COPY_ONLY, COMPRESSION, CHECKSUM, STATS = 10"
sqlcmd -S "$LOUVORVISUAL_SQL_SERVER" "${sql_user_args[@]}" -d master -b -Q "RESTORE VERIFYONLY FROM DISK = N'$server_backup_file' WITH CHECKSUM"
if [[ ! -r "$backup_file" ]]; then
    echo "Backup verificado pelo SQL Server, mas o job não consegue ler $backup_file para calcular SHA-256. Ajuste a permissão/ACL do volume compartilhado." >&2
    exit 3
fi
sha256sum "$backup_file" > "$backup_file.sha256.tmp"
mv "$backup_file.sha256.tmp" "$backup_file.sha256"
printf 'backup=%s\nserver_backup=%s\nsha256=%s\nverified=RESTORE_VERIFYONLY\n' "$backup_file" "$server_backup_file" "$(cut -d ' ' -f 1 "$backup_file.sha256")"
