#!/usr/bin/env bash
set -euo pipefail

# Restaura somente em diretórios e banco isolados. Não mescla mídia em produção.
: "${LOUVORVISUAL_MEDIA_ARCHIVE:?defina LOUVORVISUAL_MEDIA_ARCHIVE}"
: "${LOUVORVISUAL_MEDIA_CHECKSUMS:?defina LOUVORVISUAL_MEDIA_CHECKSUMS}"
: "${LOUVORVISUAL_RESTORE_MEDIA_DIR:?defina LOUVORVISUAL_RESTORE_MEDIA_DIR}"
[[ -r "$LOUVORVISUAL_MEDIA_ARCHIVE" && -r "$LOUVORVISUAL_MEDIA_CHECKSUMS" && -r "$LOUVORVISUAL_MEDIA_ARCHIVE.sha256" && -r "$LOUVORVISUAL_MEDIA_CHECKSUMS.sha256" ]] || { echo 'Arquivo de mídia, checksums ou hashes laterais não pode ser lido.' >&2; exit 2; }
( cd "$(dirname "$LOUVORVISUAL_MEDIA_ARCHIVE")" && sha256sum -c "$(basename "$LOUVORVISUAL_MEDIA_ARCHIVE").sha256" )
( cd "$(dirname "$LOUVORVISUAL_MEDIA_CHECKSUMS")" && sha256sum -c "$(basename "$LOUVORVISUAL_MEDIA_CHECKSUMS").sha256" )
restore_media_dir="${LOUVORVISUAL_RESTORE_MEDIA_DIR%/}"
[[ "$restore_media_dir" != / && -n "$restore_media_dir" ]] || { echo 'Diretório de mídia de restore inválido.' >&2; exit 2; }
if [[ -e "$restore_media_dir" ]] && find "$restore_media_dir" -mindepth 1 -print -quit | grep -q .; then
  echo 'Diretório de mídia de restore deve estar vazio.' >&2; exit 2
fi
mkdir -p "$restore_media_dir"

# Recusa caminhos absolutos e travessia antes da extração.
tar -tf "$LOUVORVISUAL_MEDIA_ARCHIVE" | awk 'BEGIN { ok=1 } /^\// || /(^|\/)\.\.($|\/)/ { ok=0 } END { exit ok ? 0 : 1 }' || { echo 'Arquivo de mídia contém caminho inseguro.' >&2; exit 2; }
tar --extract --file "$LOUVORVISUAL_MEDIA_ARCHIVE" --directory "$restore_media_dir" --no-same-owner --no-same-permissions
( cd "$restore_media_dir" && sha256sum -c "$LOUVORVISUAL_MEDIA_CHECKSUMS" )
"$(dirname "$0")/db-restore-test.sh"
printf 'restore_media_dir=%s\nresult=database-and-media-restored-and-verified\n' "$restore_media_dir"
