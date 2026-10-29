#!/bin/sh
# certbot --deploy-hook for CollabSpace. certbot runs it (as root) after each
# successful issue or renewal, with RENEWED_LINEAGE=/etc/letsencrypt/live/<domain>.
#
# Why a copy instead of mounting /etc/letsencrypt/live/<domain>:
#  - live/<domain>/*.pem are RELATIVE symlinks into ../../archive/, which
#    dangle when only live/<domain> is mounted (Nginx then fails to start:
#    "cannot load certificate"; reproduced in Week 7);
#  - privkey.pem is root-only (0600); Nginx runs as uid/gid 101.
# So: copy (following symlinks) into a directory that Nginx's group can read,
# swap atomically, test the configuration, reload Nginx without dropping
# connections.
#
#   certbot certonly --webroot -w /opt/collabspace/acme -d collab.example.com \
#     --deploy-hook /opt/collabspace/deploy/certbot-deploy-hook.sh
set -eu
: "${RENEWED_LINEAGE:?run this from certbot --deploy-hook (RENEWED_LINEAGE is not set)}"
dest="${COLLABSPACE_TLS_DIR:-/etc/collabspace/tls}"      # = TLS_DIR in deploy/.env
group="${COLLABSPACE_TLS_GROUP:-101}"                    # Nginx's gid in the proxy image
compose="${COLLABSPACE_COMPOSE:-/opt/collabspace/deploy/compose.yaml}"

umask 077
mkdir -p "$dest"
chgrp "$group" "$dest"
chmod 750 "$dest"
# cp -L follows the symlinks; the .new files are swapped in with mv, which
# is atomic within one directory, so Nginx never reads a half-written file.
cp -L "$RENEWED_LINEAGE/fullchain.pem" "$dest/fullchain.pem.new"
cp -L "$RENEWED_LINEAGE/privkey.pem" "$dest/privkey.pem.new"
chgrp "$group" "$dest/fullchain.pem.new" "$dest/privkey.pem.new"
chmod 644 "$dest/fullchain.pem.new"
chmod 640 "$dest/privkey.pem.new"
mv -f "$dest/fullchain.pem.new" "$dest/fullchain.pem"
mv -f "$dest/privkey.pem.new" "$dest/privkey.pem"

if [ "${COLLABSPACE_SKIP_RELOAD:-}" = 1 ]; then
  echo "certificate installed in $dest (reload skipped)"
  exit 0
fi
# Test first: a broken certificate must not take the running proxy down.
docker compose -f "$compose" exec -T proxy nginx -t
docker compose -f "$compose" exec -T proxy nginx -s reload
echo "certificate installed in $dest and Nginx reloaded"
