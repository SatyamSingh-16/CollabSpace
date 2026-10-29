# CollabSpace operations runbook

How to set up, upgrade, back up, restore, configure and stop a CollabSpace server (`cmd/server`) and its PostgreSQL database.

Every procedure here was actually run:
- **Part 1 (§1–§10):** the bare binaries, run during Week 5. The procedures for an existing database were run against a **restored copy** of the development database, never against the original; results in `teach/phases/week-5-review.md` §F.
- **Part 2 (§11–§20):** the containerized deployment (Docker Compose, Nginx, TLS), run during Week 6 on a local Docker Desktop; results in `teach/phases/week-6-deployment.md`. **Public TLS on a real domain has not been verified:** no domain or public host was available.

> **Never** run a migration's Down step, `DROP` or `TRUNCATE` against a database whose data matters without a fresh, verified backup. Migration 00002's Down deletes every account.

All commands assume the PostgreSQL client tools (`pg_dump`, `pg_restore`, `createdb`, `psql`) are installed. Commands that take a database name use the PostgreSQL socket in `/tmp`, as in local development; add `-h`/`-p`/`-U` for other servers. `DATABASE_URL` may contain a password: keep it out of shell history and logs. The tools here never print it.

## 1. Build

```bash
go build -trimpath -o bin/server ./cmd/server   # the application server
go build -trimpath -o bin/admin  ./cmd/admin    # migrations and maintenance
cd frontend && npm ci && npm run build          # static files in frontend/dist
```

- **Go builds are reproducible:** two `-trimpath` builds of `cmd/server`, one after `go clean -cache`, were byte-identical (same SHA-256). Dependencies are pinned in `go.mod`/`go.sum`.
- **Frontend builds are reproducible:**
  - `npm ci` installs exactly what `package-lock.json` lists.
  - Two `vite build` runs gave identical files, and so did a clean `npm ci` followed by `npm run build` in a separate directory.
  - No source maps are emitted.
  - npm 11 prints an "install-scripts" notice during `npm ci`. Installation and the build still succeed.

## 2. Configuration

All settings are environment variables; `.env.example` documents each one with its default. The database URL may instead be read from a file: set `DATABASE_URL_FILE=/run/secrets/database_url` (both the server and `admin` support it; setting both is refused). Use this with container secrets, so the password isn't in the environment or in `docker inspect` output. The server checks them at startup and **refuses to start** (exit status 2, one line per problem, no secrets printed) when, for example:

| Problem | Example message |
|---|---|
| `DATABASE_URL` or `ALLOWED_ORIGINS` missing | `DATABASE_URL is required` |
| An origin with a path, `*` or a trailing slash | `origins have no trailing slash` |
| `COOKIE_SECURE=false` with an `https://` or non-loopback origin | `COOKIE_SECURE=false is only allowed when every ALLOWED_ORIGINS entry is http://localhost, 127.0.0.1 or [::1]` |
| A rate rule that is malformed or refills faster than 1/ms | `RATE_LIMIT_LOGIN_PER_IP: "2000000000/1s" refills faster than one token per millisecond` |
| `SESSION_TTL` outside 5m–90d, bad `LOG_LEVEL`/`LOG_FORMAT` | |

If the database is unreachable, the server exits with status 1 and logs `database unreachable` with the host and user. The password is not logged (checked).

**Production checklist:**
- `COOKIE_SECURE` unset or `true`;
- `ALLOWED_ORIGINS` set to the exact `https://` origin;
- `TRUSTED_PROXY_IP_HEADER` set only if a proxy you control **overwrites** that header;
- `MIGRATE_ON_START=false` if you want to run migrations yourself, after a backup (§4).

## 3. A new database

```bash
createdb collabspace
DATABASE_URL='postgres:///collabspace?host=/tmp' bin/admin migrate-status   # schema version 0, 3 pending
DATABASE_URL='postgres:///collabspace?host=/tmp' bin/admin migrate          # schema version: 0 -> 3
```

- **`migrate-status` is read-only.** On a database that was never migrated, it doesn't even create goose's version table (tested: `TestStatusIsReadOnlyAndReportsPending`).
- **Starting the server migrates too:** with `MIGRATE_ON_START=true` (the default), the server runs the same step at startup.
- **Concurrent starts are safe:** a PostgreSQL advisory lock makes them take turns (`TestConcurrentUpIsSerialised`).

## 4. Backup

Logical backup in PostgreSQL's custom format. It includes the schema, the migration history (`goose_db_version`) and all rows.

```bash
pg_dump -Fc -f collabspace-$(date +%Y%m%d-%H%M%S).dump collabspace
```

- **It contains secrets:** password hashes and session token hashes. Store it like the database: restricted permissions, encrypted at rest, and never in the repository.
- **It is consistent:** `pg_dump` reads one snapshot and doesn't block the application.
- **Take one before every migration,** and before any manual SQL.

## 5. Restore

Restore into a **new, empty** database, then check it before switching anything over:

```bash
createdb collabspace_restored
pg_restore --single-transaction --exit-on-error -d collabspace_restored collabspace-YYYYMMDD-HHMMSS.dump
DATABASE_URL='postgres:///collabspace_restored?host=/tmp' bin/admin migrate-status
```

- **Why the flags:** `--single-transaction --exit-on-error` makes a failed restore leave nothing half-applied.
- **Don't restore over a migrated database:** the dump creates every table itself, so restoring into a database the server has already migrated would fail on existing objects. (That follows from how `pg_restore` works; it wasn't run here.) Always use a fresh one.
- **Verify before switching:** compare per-document fingerprints between the source and the restored copy. The query used in Week 5 prints only counts and hashes, never emails, payloads or tokens:

```sql
SELECT d.id, d.head_seq, count(u.seq) AS updates, coalesce(max(u.seq), 0) AS max_seq,
       md5(coalesce(string_agg(u.seq || ':' || u.user_id || ':' || u.client_id || ':' || u.client_msg_id
                               || ':' || md5(u.payload), ',' ORDER BY u.seq), '')) AS log_fingerprint
FROM documents d LEFT JOIN document_updates u ON u.document_id = d.id
GROUP BY d.id ORDER BY d.id;
```

For every document, `head_seq` must equal `updates` and `max_seq` (the log has no gaps), and the fingerprints must match the source's.

**Verified 2026-10-28:**
- `collabspace_dev` was dumped (read-only) and restored into a throwaway database.
- All 3 documents, 29 updates, users, members and sessions, the schema version, and the not-yet-validated foreign key were identical.
- The throwaway database and the dump were deleted afterwards.

## 6. Upgrading an existing database

1. Back up (§4) and verify that the backup restores (§5).
2. `bin/admin migrate-status`: read the list of pending migrations.
3. `bin/admin migrate`, or start the new server with `MIGRATE_ON_START=true`.
4. `bin/admin migrate-status` (now "pending: none"), then the fingerprint query: every document must be unchanged.

**Verified 2026-10-28** on a restored copy of the development data:
- Migration 00003 was removed by hand to simulate a v2 database.
- `admin migrate` took it to v3.
- Every document, update, user, member and session was identical before and after.

The repository's tests also upgrade from v1 and v2 data (`TestMigration2KeepsWeek1Data`, `TestMigration3KeepsLegacyRowsAndEnforcesNewOnes`).

**Locking:** a migration runs in one transaction and may block writes to the tables it changes until it commits (00003 does; see its header). Run upgrades when a short write pause is acceptable.

## 7. Shutdown

Send `SIGTERM` (or `SIGINT`). The server then:
1. makes `/readyz` answer 503, so a load balancer stops sending traffic;
2. stops accepting HTTP requests and finishes the ones in flight;
3. closes every WebSocket with **1001 "server shutting down"**; clients reconnect and resend anything unconfirmed;
4. closes the database pool and exits 0.

All of this is bounded by `SHUTDOWN_TIMEOUT` (default 15s). Past the deadline, remaining sockets are closed without waiting, and the "stopped" log line says `"forced": true`.

**Verified 2026-10-28:**
- **Setup:** the built server ran against a restored copy, with one registered user, one open document and one committed update.
- **After `SIGTERM`:** the client received close 1001, and the server exited 0 after 18 ms.
- **The log showed:**
  - `shutting down` (1 room, 1 connection);
  - `left` with `close_code` 1001 and the connection's `request_id`;
  - `stopped` with `"forced": false` and 0 rooms and 0 connections.
- **No secrets:** no password or cookie appeared in the log.

## 8. Health, logs and counters

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Liveness: the process serves HTTP. It doesn't touch the database. |
| `GET /readyz` | Readiness: 200 if the database answers within 2s and the server isn't shutting down; otherwise 503. |

- **Log format:** JSON lines on stdout (`LOG_FORMAT=text` for local reading).
- **Request ID:** every request gets one, returned in the `X-Request-Id` response header. An incoming `X-Request-Id` is kept only if it is 1–64 characters of `A–Z a–z 0–9 . _ -` (for example Nginx's `$request_id`). WebSocket `joined`/`left` lines carry the ID of their upgrade request, so a user's report can be traced through the logs.
- **Never logged** (tested in `TestLogsContainNoSecretsAndCarryRequestIDs`): passwords, cookies or session tokens, email addresses, document contents.
- **Panics** become one `panic` line with the request ID and stack, and the client gets a plain 500.
- **Database pool** (Week 7): the same `collab stats` line carries `db_pool`: `max`, `total`, `acquired`, `idle`, `empty_acquire_total`, `acquire_wait_ms`, `canceled_acquire_total`. `acquired` stuck at `max`, with the waits rising, means pool exhaustion ([deployment.md §12](deployment.md#12-logs-signals-and-troubleshooting)).
- **Collaboration counters** are logged as `collab stats` every `STATS_LOG_INTERVAL` (default 5m), and at shutdown:

| Counter | Meaning |
|---|---|
| `rooms`, `connections` | Current numbers. |
| `joins_total`, `commits_total` | Totals since the process started. |
| `slow_evictions_total` | Clients too slow to keep up (closed with 4008; they resync). |
| `room_resets_total` | Ambiguous commits or log mismatches. **Should stay 0; investigate if not.** |
| `persist_failures_total` | Failed database writes. **Check database health if it rises.** |
| `revocations_total` | Connections closed by logout or a membership change. |

## 9. Maintenance commands

```bash
bin/admin migrate-status                     # schema version and pending migrations (read-only)
bin/admin migrate                            # apply pending migrations
bin/admin claim-document -document <uuid> -email <email>        # dry run: says whether it would be allowed
bin/admin claim-document -document <uuid> -email <email> -yes   # give an ownerless legacy document to an account
```

`claim-document` refuses documents that already have an owner or members, and it never changes their update history.

## 10. Tests and the developer database

Integration tests need `COLLABSPACE_TEST_DATABASE_URL` pointing at a disposable database whose name contains `test` (for example `collabspace_test`). Without it, the database tests **skip and still print `ok`**. Any other database name is **refused** before anything is written, so a mistake can't fill `collabspace_dev` with test data. Migration tests create and drop their own `collabspace_migtest_*` databases.


---

# Part 2 — Containerized deployment (Week 6)

## 11. What runs where

```
Internet ──443/80──▶ proxy (Nginx 1.29, uid 101)            network "edge"
                      │  TLS, static frontend, security headers, CSP
                      │  /api/*, /ws/* ──▶ app:8080
                      ▼
                     app (Go server, distroless, uid 65532)   networks "edge" + "backend"
                      │
                      ▼
                     db (PostgreSQL 17, volume "pgdata")      network "backend" (internal: no route in or out)
migrate (one-shot: admin migrate) runs before app starts      network "backend"
```

- **Files:**
  - `deploy/compose.yaml`;
  - images `deploy/app.Dockerfile` and `deploy/proxy.Dockerfile`;
  - Nginx config in `deploy/nginx/`;
  - helper scripts in `deploy/*.sh`.
- **Published ports:** only the proxy publishes ports, and only on `127.0.0.1` by default. PostgreSQL and the app publish none.
- **Startup order** is enforced by health checks, not by container start order:
  1. `db` healthy (`pg_isready`);
  2. `migrate` exits 0;
  3. `app` healthy (its `/readyz`: process up **and** database answering);
  4. `proxy` starts.

## 12. First start (local)

```bash
cp deploy/env.example deploy/.env          # edit: PUBLIC_ORIGIN, ports
deploy/gen-secrets.sh                       # deploy/secrets/db_password + database_url (random; refuses to overwrite)
deploy/gen-local-cert.sh                    # LOCAL ONLY: private CA + certificate for localhost
docker compose -f deploy/compose.yaml up -d --build --wait
deploy/smoke.sh https://localhost:8443 http://localhost:8080
```

- **Open the app:** `https://localhost:8443`. The browser warns about the private CA unless you import `deploy/secrets/tls/ca.pem`.
- **Port clash:** if host port 8080 is taken, set `HTTP_PORT=8081` in `deploy/.env` (that's what Week 6 did on this machine).
- **Verified 2026-10-28:**
  - The images built in ~21 s: app 11 MB, proxy 23 MB.
  - `up` brought the stack up in order: database healthy → `migrate` "schema version: 0 -> 3" → app healthy → proxy.
  - All 7 smoke checks passed.

## 13. Secrets and what is (not) in images

| Secret | Where it lives | How it reaches the container |
|---|---|---|
| Database password | `deploy/secrets/db_password` | Compose secret → `POSTGRES_PASSWORD_FILE` |
| Database URL (contains the password) | `deploy/secrets/database_url` | Compose secret → `DATABASE_URL_FILE` |
| TLS private key | `deploy/secrets/tls/privkey.pem`, or e.g. `/etc/letsencrypt/live/<domain>/` | read-only bind mount at `/etc/nginx/tls` |

- **Kept out of git and of every image:** `deploy/secrets/`, `deploy/.env`, `*.pem`, `*.key` and dumps are listed in `.gitignore` and `.dockerignore`.
- **Verified:**
  - the exported filesystems of both images contain no `.env`, no private key and no bytes of the database password;
  - `docker inspect` of every container doesn't contain the password;
  - the image build history has no secret-carrying step.
- **The password can't be changed by editing the file:** the Postgres volume keeps the password it was created with. `gen-secrets.sh` therefore refuses to overwrite existing files.

## 14. TLS

- **Local (what was tested):** `deploy/gen-local-cert.sh` creates a 30-day private CA and a certificate for `localhost` and `127.0.0.1`. That proves Nginx's TLS configuration works. It **does not** prove a public certificate is trusted. Verified:
  - TLS 1.3 with HTTP/2 (ALPN `h2`), and TLS 1.2;
  - TLS 1.0 and 1.1 rejected by the server (`protocol_version` alert);
  - the certificate verified against the local CA;
  - `http://` answers 308 to `https://`, keeping path and query.
- **Public domain (not verified here):**
  1. Point a DNS name at the host.
  - **Follow [`deployment.md`](deployment.md) §5–§8.**
  - ~~2. … `TLS_DIR=/etc/letsencrypt/live/<domain>` … 4. Make sure `fullchain.pem` and `privkey.pem` are readable by uid 101 …~~ **Correction (Week 7):** mounting `/etc/letsencrypt/live/<domain>` doesn't work. Its files are relative symlinks into `../../archive/` that dangle inside the container, and Nginx fails with "cannot load certificate" (reproduced with a simulated certbot layout). The key is also root-only.
  - **Instead:** `deploy/certbot-deploy-hook.sh` copies the certificate and key into `TLS_DIR=/etc/collabspace/tls` (key 640, group 101), then tests and reloads Nginx. The HTTP-01 webroot is now mounted from `ACME_WEBROOT`; serving a challenge file was verified locally.
  - **HSTS:** enable it only after HTTPS **and** a renewal are verified, stepwise ([deployment.md §8](deployment.md#8-hsts-only-after-https-and-renewal-are-proven)).
- **Private keys:** never commit them, never put them in an image, and keep them readable only by root and the Nginx group.

## 15. The proxy (Nginx) behaviour

| Concern | Setting |
|---|---|
| WebSocket | `/ws/`: `proxy_http_version 1.1`, `Upgrade` / `Connection: upgrade`; `proxy_read_timeout`/`proxy_send_timeout` 75 s (the app pings every 25 s, read deadline 60 s); no buffering |
| Client IP | `X-Real-IP` and `X-Forwarded-For` are **overwritten** with `$remote_addr`, so client-sent values never reach the app. The app trusts `X-Real-IP` (`TRUSTED_PROXY_IP_HEADER`) only because nothing but Nginx can reach it. |
| Request size | `client_max_body_size 64k` (the API's JSON limit); WebSocket frames are limited by the app (1 MiB) |
| Auth endpoints | an extra per-address limit on `/api/auth/(login\|register)`, `AUTH_RATE_LIMIT` (default 5 r/s, burst 10), in front of the app's own limits |
| Health | `/healthz` and `/readyz` answer 404 publicly; the containers probe them directly |
| Headers | CSP `default-src 'self'; script-src 'self'; style-src 'self'; … frame-ancestors 'none'`, `nosniff`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`; HSTS only when `HSTS_MAX_AGE` is set |
| Caching | `/assets/*` (hashed) cached 1 year, immutable; `index.html` and SPA routes `no-cache`; the API sends `no-store` itself |
| Request IDs | Nginx's `$request_id` is passed as `X-Request-Id`; the app keeps it, so Nginx's and the app's log lines share one ID |
| Logs | JSON lines without query strings, cookies or headers |

**Docker Desktop caveat:** on macOS, every client reaches Nginx from Docker's gateway address (`172.19.0.1` here), so per-address limits treat all local clients as one. On a Linux host with published ports, the client's real address normally reaches Nginx (not verified here). If another proxy or load balancer sits in front of Nginx, configure `set_real_ip_from` for it. Otherwise all traffic appears to come from that proxy.

## 16. Upgrading

```bash
deploy/backup.sh                                          # 1. backup first (§17)
docker compose -f deploy/compose.yaml build               # 2. new images
docker compose -f deploy/compose.yaml run --rm migrate    # 3. pending migrations, prints "schema version: a -> b"
docker compose -f deploy/compose.yaml up -d --wait        # 4. recreate app and proxy
```

- **Migrations only move forward:** the `migrate` service only ever runs `admin migrate`, i.e. migrations that move forward, under an advisory lock. Nothing in the deployment migrates down or drops data.
- **Downtime during a recreate:** `up -d` recreates the app; the old one closes WebSockets with 1001 and clients reconnect. This is a short outage, not a zero-downtime deploy: a single instance can't be replaced without one.
- **Verified 2026-10-28, on the stack's own test data** (547 documents, 82,954 updates, 10,031 users), with a fingerprint per document:
  - `down` (without `-v`) and `up`: identical;
  - migration 00003 rolled back by hand, then `run --rm migrate` ("2 -> 3"): identical, with the foreign key validated again.

## 17. Backup and restore (containerized)

```bash
deploy/backup.sh                         # → deploy/backups/collabspace-YYYYMMDD-HHMMSS.dump (mode 600, git-ignored)
```

Restore into a **new** database next to the live one, check it, then switch:

```bash
dc="docker compose -f deploy/compose.yaml"
$dc exec -T db createdb -U collabspace collabspace_restored
$dc exec -T db pg_restore -U collabspace --single-transaction --exit-on-error -d collabspace_restored < deploy/backups/<file>.dump
# compare the fingerprint query (§5) on collabspace and collabspace_restored, then, with the app stopped:
$dc stop app
$dc exec -T db psql -U collabspace -d postgres -c 'ALTER DATABASE collabspace RENAME TO collabspace_old' \
                                                 -c 'ALTER DATABASE collabspace_restored RENAME TO collabspace'
$dc start app
```

- **The old database is kept** (`collabspace_old`) until you drop it yourself.
- **Verified 2026-10-28** (dump, restore into `collabspace_restored`, compare): a 14.3 MB dump of 547 documents, 82,954 updates and 10,031 users restored **identically**.
- **Not run here:** the rename swap at the end.
- **Losing the volume:** if the volume itself is lost, start a fresh stack (`up` creates an empty, migrated database), then restore into a new database and swap as above.
- **A mistake made while testing:** the first comparison attempt compared two empty fingerprints, because zsh didn't split a `$dc` command variable, and printed "identical". Always check that the fingerprints are non-empty.

## 18. Stopping and restarting

| Action | What happens (measured 2026-10-28) |
|---|---|
| `docker compose stop app` | SIGTERM → the app closes all WebSockets with **1001** and exits. With 500 connections open: `stop` took 0.42 s, and the app's own shutdown took 10 ms, `forced: false`. `stop_grace_period` is 30 s and `SHUTDOWN_TIMEOUT` 20 s. |
| `docker compose start app` | healthy within 6.4 s (the probe runs every 5 s); clients reconnect with backoff. All 500 resynced (close → resynced p50 7.3 s, including 5 s of deliberate downtime). |
| `docker compose stop proxy` | SIGQUIT → Nginx stops accepting, waits `worker_shutdown_timeout` (10 s), then closes the remaining sockets without a WebSocket close frame (clients see 1006). Took 10.5 s; all 8 clients recovered after `start`. |
| Database stopped | the app's readiness probe answers 503, and the container turns unhealthy after 6 failed probes (~30 s). API calls that need the database return 500. After `start db`, the app recovered with **no restart**. |

## 19. Load testing (local only)

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.loadtest.yaml up -d --wait   # lifts registration/login/share limits!
deploy/loadtest.sh -docs 4 -members 3 -writers 1 -rate 5 -duration 10s              # smoke size first
docker compose -f deploy/compose.yaml up -d --wait                                   # back to normal limits
```

- **Why the override exists:** each run registers `docs × members` fresh users from one address, so `compose.loadtest.yaml` turns off the registration, login and share limits. **Never use it where real users can reach the stack.**
- **The harness** (`cmd/loadtest`) caps runs at 2,000 connections. Reports and `docker stats` samples go to `deploy/loadtest-results/`.
- Results and their limits: `teach/phases/week-6-deployment.md` §E.

## 20. Continuous integration

`.github/workflows/ci.yml` has four jobs, each with read-only repository permissions. Actions are pinned to commit SHAs (resolved with `git ls-remote`), and tool images by digest.
1. **Go:** gofmt, vet, `go test -race` against a Postgres service container, and a check that no test was skipped.
2. **Frontend:** `npm ci`, typecheck and build, Vitest including end-to-end tests, Chromium Playwright. The job **fails if Vitest or Playwright report skipped tests** (Week 7; checked locally: 9 and 6 skips were caught without the database URL).
3. **Lint (Week 7):** actionlint (with ShellCheck on workflow scripts), ShellCheck on `deploy/*.sh`, hadolint on both Dockerfiles.
4. **Deploy smoke:** `compose config`, build, `up --wait` with throwaway secrets and a local certificate, a Trivy gate (fixable HIGH/CRITICAL in our two images fails the job), `deploy/smoke.sh`, then `down -v` on the CI runner's throwaway volume.

Each job's database is a throwaway service container named `collabspace_test`, and the tests refuse other names.

**Status:**
- **Not run on GitHub:** this machine has no git repository and no GitHub access.
- **Linted:** the workflow passes `actionlint` (including ShellCheck on its scripts).
- **Run locally on Linux:** the Go job's steps and the frontend job's steps, in containers (results in the Week 6 chapter).
- **The first hosted run is still to be done.**
