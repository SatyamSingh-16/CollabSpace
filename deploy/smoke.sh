#!/bin/sh
# Smoke test of a running stack through Nginx. Prints statuses only.
#   deploy/smoke.sh [https-base] [http-base]
# Local stack: trusts deploy/secrets/tls/ca.pem (gen-local-cert.sh).
# Real deployment: SMOKE_CA=system deploy/smoke.sh https://collab.example.com http://collab.example.com
# uses the system's trusted CAs, so it also checks the public certificate.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
https="${1:-https://localhost:8443}"
http="${2:-http://localhost:${HTTP_PORT:-8080}}"
ca="${SMOKE_CA:-$here/secrets/tls/ca.pem}"
curl() {
  if [ "$ca" = system ]; then command curl "$@"; else command curl --cacert "$ca" "$@"; fi
}
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1: want $2, got $3"; fail=1; fi
}
check "http redirects to https" 308 "$(curl -s -o /dev/null -w '%{http_code}' "$http/")"
check "redirect goes to the configured https origin" "$https/" "$(curl -s -o /dev/null -w '%{redirect_url}' "$http/")"
check "index over https" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$https/")"
csp="$(curl -s -D - -o /dev/null "$https/" | grep -ic '^content-security-policy:' || true)"
check "CSP header present" 1 "$csp"
check "api answers (signed out)" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$https/api/auth/me")"
check "foreign Origin refused" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$https/api/auth/login")"
check "readyz not public" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$https/readyz")"
check "websocket without session refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $https" "$https/ws/documents/00000000-0000-4000-8000-000000000001")"
exit $fail
