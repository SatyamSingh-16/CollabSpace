# Deploying CollabSpace to a single Linux server

> **Status: NOT DEPLOYED.** No server, domain, DNS access or cloud account was available, so nothing in this document has run on a public host. Every step says what *was* verified on a local Docker Desktop stack (Week 6 and 7) and what wasn't. Use the [checklist](#13-deployment-checklist) and record your own results.

**What this deployment is:** one Linux VPS running the existing Docker Compose stack:
- Nginx with TLS → the Go server → PostgreSQL (`deploy/compose.yaml`);
- one application instance, by design. The collaboration rooms live in one process's memory, so a second app container would not work ([teach 10](../teach/10-nginx-and-deployment.md)).

Day-two operations (backups, upgrades, configuration) are in [`operations.md`](operations.md) Part 2. This document covers getting a server live and keeping it healthy.

---

## 1. Prerequisites (you provide these)

| Need | Notes |
|---|---|
| A Linux VPS | e.g. Ubuntu 24.04 LTS, 2 vCPU / 2–4 GB RAM is plenty at the measured local load; SSH key access |
| A domain name | e.g. `collab.example.com` (placeholder used below) |
| DNS control | an `A` (and optionally `AAAA`) record pointing to the VPS |
| Docker Engine + Compose plugin | from Docker's official packages |
| certbot | from the distribution or snap |
| An off-host place for backups | another machine or object storage |

---

## 2. Prepare the host

```bash
# as root on the VPS
adduser --disabled-password deploy && usermod -aG docker deploy   # members of "docker" are effectively root: keep it to admins
apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
mkdir -p /opt/collabspace && chown deploy: /opt/collabspace
```

- **Copy the repository to `/opt/collabspace`**, using `git clone` once a repository exists, or `rsync` without `.env`, `deploy/.env` and `deploy/secrets/`.
- **Secrets are created on the server:** they are generated there and never copied from a laptop.

---

## 3. Firewall: only 22, 80 and 443

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp          # better: ufw allow from <your-ip> to any port 22 proto tcp
ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

- **⚠ Docker bypasses ufw for published ports:** it inserts its own iptables rules. A container port published on `0.0.0.0` is reachable **even if ufw denies it**. This stack's protection therefore lies in what it publishes:
  - only the proxy publishes ports;
  - PostgreSQL and the app publish none;
  - the database's network is `internal: true` (verified locally: no host port, unreachable from the proxy, no route out).
- **Never add `ports:` to `db` or `app`.**
- **After starting, verify from outside** (from another machine): `nmap -Pn -p 1-65535 collab.example.com` should show only 22, 80 and 443. On the server, `ss -tlnp` should show docker-proxy only on 80 and 443.

---

## 4. Configure

```bash
cd /opt/collabspace
cp deploy/env.example deploy/.env       # then edit, see below
deploy/gen-secrets.sh                    # random DB password + URL files in deploy/secrets/ (refuses to overwrite)
```

`deploy/.env` for production:

```ini
PUBLIC_ORIGIN=https://collab.example.com
SERVER_NAME=collab.example.com
BIND_ADDR=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
PUBLIC_HTTPS_PORT_SUFFIX=
TLS_DIR=/etc/collabspace/tls
ACME_WEBROOT=/opt/collabspace/deploy/acme
HSTS_MAX_AGE=
```

- **`PUBLIC_ORIGIN`** must be exactly what browsers use. The app accepts API calls and WebSockets only from that origin.
- **Cookies:** `COOKIE_SECURE` is hard-wired to `true` in `compose.yaml`. The session cookie is `__Host-collabspace_session` with Secure, HttpOnly, SameSite=Lax and Path=/. Behind the proxy that's correct: the browser sees HTTPS, and the app needs no `X-Forwarded-Proto` logic. A `COOKIE_SECURE=false` override is refused with an https origin (exit 2, verified).
- **Secret files:** `deploy/secrets/` is mode 700 and its files 644. The directory keeps other host users out; the containers read the files through Compose secrets. The password appears in no image and no `docker inspect` output (verified locally).

---

## 5. DNS and the first certificate

```bash
dig +short collab.example.com             # must print the VPS address before continuing
```

There's a chicken-and-egg problem: Nginx won't start without a certificate, and the HTTP-01 webroot challenge needs Nginx running. Start with a temporary self-signed certificate, then let certbot replace it:

```bash
# 1. temporary self-signed certificate so the proxy can start (replaced in step 3)
install -d -m 750 -g 101 /etc/collabspace/tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=collab.example.com" \
  -keyout /etc/collabspace/tls/privkey.pem -out /etc/collabspace/tls/fullchain.pem
chgrp 101 /etc/collabspace/tls/*.pem && chmod 640 /etc/collabspace/tls/privkey.pem

# 2. start the stack (§6), so Nginx serves /.well-known/acme-challenge/ from ACME_WEBROOT on port 80
mkdir -p /opt/collabspace/deploy/acme

# 3. real certificate; try Let's Encrypt staging first (--test-cert) to avoid rate limits, then drop it
certbot certonly --webroot -w /opt/collabspace/deploy/acme -d collab.example.com \
  --deploy-hook /opt/collabspace/deploy/certbot-deploy-hook.sh --test-cert
```

**Why the deploy hook, and not a mount of `/etc/letsencrypt/live/<domain>`?**
- The files in `live/<domain>/` are **relative symlinks** into `../../archive/`. Mounted alone, they dangle, and Nginx fails with "cannot load certificate". This was reproduced in Week 7 with a simulated certbot layout; the Week 6 runbook had said to do exactly that, and it was wrong.
- `privkey.pem` is root-only, and Nginx runs as uid/gid 101.

So the hook (`deploy/certbot-deploy-hook.sh`, run by certbot as root):
1. copies the files, following the symlinks, into `TLS_DIR`: key 640 and certificate 644, group 101, directory 750;
2. swaps them in atomically;
3. runs `nginx -t` and reloads Nginx, without dropping connections.

**Verified locally:**
- with a simulated lineage: the files were copied, the permissions set, and Nginx's configuration test passed with that directory mounted;
- `nginx -t` and the reload against the running stack: HTTPS still answered 200.

**Not verified:** group-101 read access on a real Linux host. Docker Desktop on macOS is lenient about bind-mount permissions.

---

## 6. Start and check

```bash
docker compose -f deploy/compose.yaml up -d --build --wait     # db healthy → migrate (exit 0) → app healthy → proxy
docker compose -f deploy/compose.yaml ps
SMOKE_CA=system deploy/smoke.sh https://collab.example.com http://collab.example.com
```

- **What the smoke test checks** (all over the public certificate, using the system's CAs): HTTP→HTTPS 308 to the configured origin, the index page, the CSP header, the API, refusal of a foreign Origin, `/readyz` not public, and refusal of a WebSocket without a session.
- **Verified locally:** 8/8 against the local CA. With `SMOKE_CA=system`, the local private CA was correctly rejected (exit 1).
- **Check the certificate:** `echo | openssl s_client -connect collab.example.com:443 -servername collab.example.com 2>/dev/null | openssl x509 -noout -issuer -enddate`.
- **Check in a browser:** two browsers, sign up twice, share a document, edit together, reload. Then the [demo flow](../README.md#demo-flow).

**WebSockets through the proxy:**
- `/ws/` uses HTTP/1.1 Upgrade with 75 s read and send timeouts (the app pings every 25 s).
- **A CDN or another proxy in front** (e.g. Cloudflare) must allow WebSockets and keep idle timeouts above 60 s, and Nginx then needs `set_real_ip_from` for that proxy's addresses. Otherwise every client appears as the CDN and shares one rate limit.

---

## 7. Certificate renewal

- **How it renews:** certbot's packaged timer runs `certbot renew` twice a day. The `--deploy-hook` given at issue time is saved in `/etc/letsencrypt/renewal/<domain>.conf` and runs after every successful renewal.
- **Test renewal:** `certbot renew --dry-run` uses the staging servers. Deploy hooks don't run on a dry run unless your certbot supports `--run-deploy-hooks`; if it does, add that flag to exercise the hook too.
- **Check expiry regularly,** e.g. weekly from monitoring: `openssl x509 -enddate -noout -in /etc/collabspace/tls/fullchain.pem`. Let's Encrypt certificates last 90 days; renewal happens about 30 days before expiry.
- **Not verified:** no real issuance or renewal has happened anywhere for this project.

---

## 8. HSTS: only after HTTPS and renewal are proven

- **What it does:** `Strict-Transport-Security` tells browsers to use only HTTPS for this host for `max-age` seconds. Until it expires they won't connect over HTTP, and they won't let users click through certificate errors.
- **The risk:** if the certificate expires or breaks while HSTS is cached, users are locked out until it's fixed. You can't undo it remotely for browsers that already cached it.
- **`includeSubDomains`** (which this config adds) applies it to every subdomain. Only enable it if all of them serve HTTPS. Don't submit the domain to the HSTS preload list for a portfolio project; it's hard to undo.
- **Turning it on:** after §6 passes **and** at least one renewal (§7) has run, set `HSTS_MAX_AGE=300` and confirm the header. Then raise it gradually (1 day, then 1 week), and finally `31536000` (1 year). Apply each change with `docker compose -f deploy/compose.yaml up -d proxy`.

---

## 9. Migrations and upgrades

```bash
deploy/backup.sh                                           # 1. backup
deploy/verify-backup.sh deploy/backups/<newest>.dump       # 2. prove it restores (throwaway container, see §10)
docker tag collabspace-app:local collabspace-app:previous  # 3. keep the running images for rollback
docker tag collabspace-proxy:local collabspace-proxy:previous
docker compose -f deploy/compose.yaml build                # 4. new images
docker compose -f deploy/compose.yaml run --rm migrate     # 5. "schema version: a -> b" (forward only, advisory lock)
docker compose -f deploy/compose.yaml up -d --wait         # 6. recreate app and proxy; clients reconnect (1001)
SMOKE_CA=system deploy/smoke.sh https://collab.example.com http://collab.example.com
```

- **Expect a short outage:** one instance means a deploy closes all WebSockets. Measured locally with 500 connections: shutdown took 10 ms, and all clients resynced; close → resynced p95 7.8 s, including 5 s of deliberate downtime.
- **Migrations:** goose runs each migration in a transaction, so a migration that **fails** leaves the schema as it was. Fix it and run step 5 again. **Never run a Down migration** on production data: 00002's Down deletes all accounts.

---

## 10. Backups

```bash
deploy/backup.sh                       # pg_dump -Fc → deploy/backups/collabspace-<timestamp>.dump (mode 600, dir 700)
deploy/verify-backup.sh <file.dump>    # restore into a throwaway container with no network, check integrity, compare with live
```

- **Why it's consistent:** `pg_dump` reads one snapshot, so the backup is consistent while the app keeps running.
- **What the dump contains:** password hashes, session token hashes, emails and all document content. Treat it like the database.
- **Off-host copies:** a backup on the same disk doesn't survive losing the server. Copy each dump elsewhere, encrypted. With [age](https://age-encryption.org):
  ```bash
  age -r <recipient-public-key> -o backup.dump.age deploy/backups/<file>.dump
  rsync backup.dump.age backup-host:/backups/collabspace/
  ```
  Keep the private key off the server.
- **Retention (example, not verified):** keep 7 daily and 4 weekly dumps. For example:
  ```bash
  find deploy/backups -name '*.dump' -mtime +7 -delete
  ```
  together with a separate weekly copy kept longer off-host.
- **Schedule (example, not configured or verified):**
  ```cron
  15 3 * * * cd /opt/collabspace && deploy/backup.sh >> /var/log/collabspace-backup.log 2>&1
  ```
  Then **test a restore** monthly with `verify-backup.sh`. A backup that has never been restored is a hope, not a backup.
- **Verified locally (Week 7):** a 14.3 MB dump of the stack (552 documents, 82,997 updates, 10,045 users) restored in a throwaway container; 0 documents with gaps; fingerprint identical to the live database. A truncated dump made the script exit 1.
- **No point-in-time recovery:** you lose everything since the last dump. PITR would need WAL archiving, which isn't configured.

---

## 11. Rollback and recovery

| Situation | What to do |
|---|---|
| New app version misbehaves; no migration ran | `docker tag collabspace-app:previous collabspace-app:local && docker compose -f deploy/compose.yaml up -d --no-build app` |
| A migration failed | it was rolled back in its transaction. Fix it, re-run `run --rm migrate`. The old app version still works on the old schema. |
| A migration succeeded but the release must be undone | migrations are forward-only. Either roll forward with a fix, or restore the pre-upgrade backup ([operations §17](operations.md#17-backup-and-restore-containerized): restore into `collabspace_restored`, verify, stop app, rename databases, start the previous app image). Writes since the backup are lost; say so to users. |
| Database corrupted or volume lost | fresh stack (`up` creates an empty, migrated database); restore the newest verified backup into `collabspace_restored` and swap as above |
| Certificate broken | the deploy hook runs `nginx -t` before reloading, so a bad certificate doesn't take the running proxy down. Re-run `certbot renew --force-renewal` after fixing the cause. |
| Server lost | new VPS, §2–§6, restore the newest off-host backup, then point DNS at the new address |

**Never** run `docker compose down -v` on production: it deletes the database volume.

---

## 12. Logs, signals and troubleshooting

All logs are JSON lines: `docker compose -f deploy/compose.yaml logs -f app` (likewise `proxy`, `db`). The app, Nginx and WebSocket lines share the request ID that Nginx assigns and returns as `X-Request-Id`.

| Question | Signal |
|---|---|
| Is the app up and able to reach the database? | the app container's health (`docker compose ps`), which runs `/readyz`. **unhealthy** = probes failing for ~30 s (6 × 5 s) |
| Readiness failure or app failure? | `docker compose exec app /usr/local/bin/healthcheck; echo $?`: exit 1 with "status 503" means **the process is fine but the database isn't answering** (check `db`). "connection refused" means **the process isn't serving** (check app logs, `RestartCount` in `docker inspect`). |
| WebSocket disconnects | app `"msg":"left"` lines: `close_code` (1000 normal, 1001 shutdown, 4001 signed out or expired, 4003 access removed, 4008 resync or slow client, 1006 no close frame / network) and `connected_ms` |
| Reconnect storms | many `left` and `joined` pairs for the same `doc_id` within seconds; `joins_total` in `collab stats` jumping |
| Load and failure paths | `"msg":"collab stats"` every 5 min: rooms, connections, commits, `slow_evictions_total`, `room_resets_total` (should stay 0), `persist_failures_total` |
| Database connection exhaustion | the same line's `db_pool`: `acquired` equal to `max` across samples, with rising `empty_acquire_total` and `acquire_wait_ms`, means requests are queueing for connections. On the database: `docker compose exec db psql -U collabspace -d collabspace -c "select state, count(*) from pg_stat_activity group by 1"` |
| Slow or failing requests | proxy lines: `status`, `request_time`, `upstream_time`; app `"msg":"request"` lines with `duration_ms` |
| Crashes | app `"msg":"panic"` lines (with stack and request ID) |
| Shutdown | `"shutting down"` and `"stopped"` lines; `"forced": true` means `SHUTDOWN_TIMEOUT` was hit |
| Disk | `docker system df -v` (the `collabspace_pgdata` volume), `df -h` |

Example:

```bash
docker compose -f deploy/compose.yaml logs --no-log-prefix app | grep '"msg":"left"' | grep -o '"close_code":[0-9]*' | sort | uniq -c
```

---

## 13. Deployment checklist

Record the result of each step. None of them has been done for a public host yet.

- [ ] VPS created; SSH by key only; `unattended-upgrades` on
- [ ] Docker Engine + Compose plugin installed; `deploy` user
- [ ] ufw allows only 22/80/443; after start, an external `nmap` shows only those
- [ ] Repository on the server without `.env`/secrets; `deploy/.env` set for production; `deploy/gen-secrets.sh` run there
- [ ] DNS `A`/`AAAA` record resolves to the VPS
- [ ] Temporary certificate in `/etc/collabspace/tls`; stack up (`--wait` succeeded)
- [ ] Staging certificate via webroot + deploy hook works; then the real certificate
- [ ] `SMOKE_CA=system deploy/smoke.sh …`: 8/8
- [ ] `openssl s_client` shows the Let's Encrypt chain and the expiry date
- [ ] Two-browser demo works (edit, presence, reconnect, reload)
- [ ] `certbot renew --dry-run` succeeds
- [ ] First backup taken, copied off-host, and **restored** with `verify-backup.sh`
- [ ] Backup schedule and retention configured and observed for a week
- [ ] HSTS enabled stepwise (§8), only after all of the above
- [ ] Image digests of the release recorded: `docker image inspect collabspace-app:local --format '{{.Id}}'`
