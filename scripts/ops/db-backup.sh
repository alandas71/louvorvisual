#!/usr/bin/env bash
set -euo pipefail

# Execute em ambiente protegido. Defina MYSQL_PWD pelo cofre, nunca na linha de comando.
: "${LOUVORVISUAL_MYSQL_HOST:?defina LOUVORVISUAL_MYSQL_HOST}"
: "${LOUVORVISUAL_MYSQL_DATABASE:?defina LOUVORVISUAL_MYSQL_DATABASE}"
: "${LOUVORVISUAL_MYSQL_USER:?defina LOUVORVISUAL_MYSQL_USER}"
: "${LOUVORVISUAL_BACKUP_DIR:?defina LOUVORVISUAL_BACKUP_DIR}"
backup_dir="${LOUVORVISUAL_BACKUP_DIR%/}"
stamp="${LOUVORVISUAL_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'LOUVORVISUAL_BACKUP_STAMP deve usar YYYYMMDDTHHMMSSZ.' >&2; exit 2; }
mkdir -p "$backup_dir"
backup_file="$backup_dir/${LOUVORVISUAL_MYSQL_DATABASE}-${stamp}.sql.gz"
temporary_file="$backup_file.tmp"
mysql_args=(-h "$LOUVORVISUAL_MYSQL_HOST" -u "$LOUVORVISUAL_MYSQL_USER")
[[ -n "${LOUVORVISUAL_MYSQL_PORT:-}" ]] && mysql_args+=(-P "$LOUVORVISUAL_MYSQL_PORT")

mysqldump "${mysql_args[@]}" --single-transaction --routines --events --add-drop-table --databases "$LOUVORVISUAL_MYSQL_DATABASE" | gzip -c > "$temporary_file"
mv "$temporary_file" "$backup_file"
gzip -t "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256.tmp"
mv "$backup_file.sha256.tmp" "$backup_file.sha256"
printf 'backup=%s\nsha256=%s\nverified=gzip-integrity\n' "$backup_file" "$(cut -d ' ' -f 1 "$backup_file.sha256")"
