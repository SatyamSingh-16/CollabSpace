#!/bin/sh
# LOCAL TESTING ONLY: a private CA and a certificate for localhost/127.0.0.1,
# written to deploy/secrets/tls. Browsers and other machines don't trust it
# unless you import ca.pem yourself; this is not public TLS.
# For a real domain use a publicly trusted certificate (docs/operations.md).
set -eu
dir="$(cd "$(dirname "$0")" && pwd)/secrets/tls"
mkdir -p "$dir"
chmod 700 "$dir"
cd "$dir"
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=CollabSpace local CA" -keyout ca.key -out ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -subj "/CN=localhost" -keyout privkey.pem -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 \
  -extfile ext.cnf -out fullchain.pem 2>/dev/null
rm -f server.csr ext.cnf ca.srl ca.key   # the CA key isn't needed again
# Nginx runs as uid 101 and must read the key; this is a throwaway local key.
chmod 644 privkey.pem fullchain.pem ca.pem
echo "wrote $dir/{fullchain.pem,privkey.pem,ca.pem} (valid 30 days, localhost only)"
