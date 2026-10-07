#!/usr/bin/env bash
set -euo pipefail

# Snapshot operacional: o SQL Server gera o .bak consistente; os bytes privados
# são arquivados e cada objeto recebe SHA-256 no mesmo manifesto de conjunto.
: "${LOUVORVISUAL_MEDIA_DIR:?defina LOUVORVISUAL_MEDIA_DIR}"
: "${LOUVORVISUAL_BACKUP_DIR:?defina LOUVORVISUAL_BACKUP_DIR}"
: "${LOUVORVISUAL_SQL_DATABASE:?defina LOUVORVISUAL_SQL_DATABASE}"
media_dir="${LOUVORVISUAL_MEDIA_DIR%/}"
backup_dir="${LOUVORVISUAL_BACKUP_DIR%/}"
[[ -d "$media_dir" ]] || { echo 'LOUVORVISUAL_MEDIA_DIR não existe.' >&2; exit 2; }
mkdir -p "$backup_dir"

stamp="${LOUVORVISUAL_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'LOUVORVISUAL_BACKUP_STAMP deve usar YYYYMMDDTHHMMSSZ.' >&2; exit 2; }
export LOUVORVISUAL_BACKUP_STAMP="$stamp"
"$(dirname "$0")/db-backup.sh"

prefix="$backup_dir/${LOUVORVISUAL_SQL_DATABASE}-${stamp}"
media_archive="$prefix.media.tar"
media_checksums="$prefix.media.sha256"
manifest="$prefix.manifest"
temporary_archive="$media_archive.tmp"
temporary_checksums="$media_checksums.tmp"

# Os nomes dentro do tar são relativos à raiz privada, e o arquivo só é publicado
# após tar e hashes concluírem.
(
  cd "$media_dir"
  while IFS= read -r -d '' file; do sha256sum "$file"; done < <(find . -type f -print0 | sort -z)
) > "$temporary_checksums"
tar --create --file "$temporary_archive" --directory "$media_dir" --sort=name --format=posix .
mv "$temporary_archive" "$media_archive"
mv "$temporary_checksums" "$media_checksums"
sha256sum "$media_archive" > "$media_archive.sha256"
sha256sum "$media_checksums" > "$media_checksums.sha256"

{
  printf 'format=louvorvisual-backup-v1\n'
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_backup=%s\n' "$(basename "$prefix.bak")"
  printf 'database_sha256=%s\n' "$(cut -d ' ' -f 1 "$prefix.bak.sha256")"
  printf 'media_archive=%s\n' "$(basename "$media_archive")"
  printf 'media_archive_sha256=%s\n' "$(cut -d ' ' -f 1 "$media_archive.sha256")"
  printf 'media_checksums=%s\n' "$(basename "$media_checksums")"
  printf 'media_checksums_sha256=%s\n' "$(cut -d ' ' -f 1 "$media_checksums.sha256")"
  printf 'media_files=%s\n' "$(wc -l < "$media_checksums" | tr -d ' ')"
} > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"
printf 'manifest=%s\nresult=database-and-media-verified\n' "$manifest"
