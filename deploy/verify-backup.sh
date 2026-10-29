#!/bin/sh
# Verifies a backup without touching the live database: restores the dump
# into a THROWAWAY PostgreSQL container (no network, deleted afterwards),
# checks integrity, and compares it with the live database.
#   deploy/verify-backup.sh deploy/backups/collabspace-YYYYMMDD-HHMMSS.dump
# Prints counts and hashes only, never rows, emails or payloads.
# Exit status: 0 = restored and intact; 1 = restore failed or integrity
# problem. A difference from the live database is reported, not fatal: the
# live database may have changed since the backup.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dump="${1:?usage: deploy/verify-backup.sh <file.dump>}"
[ -r "$dump" ] || { echo "cannot read $dump" >&2; exit 1; }
image="${VERIFY_IMAGE:-postgres:17.11-alpine}"
name="collabspace-verify-$$"

# trust auth is acceptable only because the container has no network at all.
docker run -d --name "$name" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=verify "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
i=0
until docker exec "$name" pg_isready -U postgres -d verify >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "throwaway database did not start" >&2; exit 1; }; sleep 1
done
sleep 2 # the image restarts PostgreSQL once after initialising

# --no-owner/--no-privileges: the backup's role doesn't exist in the throwaway.
docker exec -i "$name" pg_restore -U postgres --no-owner --no-privileges --single-transaction --exit-on-error -d verify < "$dump"

summary="SELECT 'documents=' || count(*) || ' updates=' || coalesce(sum(u.n), 0)
  || ' documents_with_gaps=' || count(*) FILTER (WHERE d.head_seq <> coalesce(u.n, 0) OR d.head_seq <> coalesce(u.mx, 0))
  || ' users=' || (SELECT count(*) FROM users) || ' members=' || (SELECT count(*) FROM document_members)
  || ' updates_without_author=' || (SELECT count(*) FROM document_updates x WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = x.user_id))
  || ' schema=' || (SELECT max(version_id) FROM goose_db_version WHERE is_applied)
  || ' fingerprint=' || md5(coalesce(string_agg(d.id || ':' || d.head_seq || ':' || coalesce(u.h, ''), ',' ORDER BY d.id), ''))
FROM documents d LEFT JOIN (
  SELECT document_id, count(*) n, max(seq) mx,
         md5(string_agg(seq || ':' || user_id || ':' || client_id || ':' || client_msg_id || ':' || md5(payload), ',' ORDER BY seq)) h
  FROM document_updates GROUP BY document_id) u ON u.document_id = d.id"

restored=$(docker exec -i "$name" psql -U postgres -d verify -v ON_ERROR_STOP=1 -Atc "$summary")
echo "restored: $restored"
live=$(docker compose -f "$here/compose.yaml" exec -T db psql -U collabspace -d collabspace -v ON_ERROR_STOP=1 -Atc "$summary" 2>/dev/null || echo "(live database not reachable)")
echo "live:     $live"

status=0
case "$restored" in
  *" documents_with_gaps=0 "*) ;;
  *) echo "INTEGRITY PROBLEM: some document's head_seq doesn't match its update log"; status=1 ;;
esac
# Legacy rows (Week 1) may legitimately have no author account; report it.
case "$restored" in *" updates_without_author=0 "*) ;; *) echo "note: some updates reference no account (legacy rows; see teach week-3 §E)" ;; esac
if [ "$restored" = "$live" ]; then
  echo "backup matches the live database exactly"
else
  echo "backup differs from the live database (expected if it changed since the backup)"
fi
[ "$status" -eq 0 ] && echo "VERIFIED: the backup restores and its document logs are intact"
exit "$status"
