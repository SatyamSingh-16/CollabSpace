#!/bin/sh
# Logical backup of the containerized database (pg_dump custom format) to
# deploy/backups/ (git- and docker-ignored). The dump contains password and
# session hashes: keep it private. Restore steps: docs/operations.md.
#   deploy/backup.sh [output-directory]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/backups}"
mkdir -p "$out"
chmod 700 "$out"
umask 077
file="$out/collabspace-$(date +%Y%m%d-%H%M%S).dump"
docker compose -f "$here/compose.yaml" exec -T db pg_dump -U collabspace -Fc collabspace > "$file"
echo "wrote $file ($(wc -c < "$file" | tr -d ' ') bytes)"
