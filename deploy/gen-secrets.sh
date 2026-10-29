#!/bin/sh
# Creates deploy/secrets/db_password and deploy/secrets/database_url with a
# random password. Refuses to overwrite: the password of an existing
# database volume can't be changed by rewriting these files.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)/secrets"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -e "$dir/db_password" ] || [ -e "$dir/database_url" ]; then
  echo "secrets already exist in $dir; not overwriting" >&2
  exit 1
fi
umask 077
pw=$(openssl rand -hex 24)
printf '%s' "$pw" > "$dir/db_password"
# The database is on the internal Docker network only; no TLS between app
# and database.
printf 'postgres://collabspace:%s@db:5432/collabspace?sslmode=disable' "$pw" > "$dir/database_url"
# The containers read these as non-root users (Postgres: 70, app: 65532).
chmod 644 "$dir/db_password" "$dir/database_url"
echo "wrote $dir/db_password and $dir/database_url (password not printed)"
