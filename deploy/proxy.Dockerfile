# syntax=docker/dockerfile:1
# Nginx with the built frontend. TLS certificates are NOT in the image; they
# are mounted at runtime (see deploy/compose.yaml). Build from the repo root:
#   docker build -f deploy/proxy.Dockerfile -t collabspace-proxy .

FROM node:26.11.1-alpine AS web
WORKDIR /web
# Exactly the versions in the committed lockfile.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Runs as uid 101 and listens on unprivileged ports 8080/8443; the host maps
# 80/443 (or other ports) to them. STOPSIGNAL is SIGQUIT: graceful shutdown.
FROM nginxinc/nginx-unprivileged:1.29-alpine
USER root
# apk upgrade: the upstream image lagged its Alpine security fixes (Week 7:
# 47 HIGH findings in the base, 0 after upgrading). The trade-off: a rebuild
# picks up whatever patches exist that day, so record the image digest of
# each release (docs/deployment.md).
RUN apk upgrade --no-cache \
 && rm -f /etc/nginx/conf.d/default.conf && mkdir -p /var/www/acme && chown 101:101 /var/www/acme
USER 101
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/ /etc/nginx/snippets/
COPY deploy/nginx/templates/ /etc/nginx/templates/
COPY --from=web /web/dist/ /usr/share/nginx/html/
