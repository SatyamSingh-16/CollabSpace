# syntax=docker/dockerfile:1
# CollabSpace application image: the server, the admin tool (migrations,
# maintenance) and a health probe. Build from the repository root:
#   docker build -f deploy/app.Dockerfile -t collabspace-app .

FROM golang:1.26.10-alpine AS build
WORKDIR /src
# Dependencies first, so source edits don't invalidate the module cache layer.
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations
# Static binaries (pgx is pure Go), no local paths, no VCS stamp (the build
# context has no .git), so the same source gives the same binaries.
ENV CGO_ENABLED=0
RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/server ./cmd/server \
 && go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/admin ./cmd/admin \
 && go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/healthcheck ./cmd/healthcheck

# Distroless: no shell, no package manager, CA certificates and tzdata only.
# "nonroot" is uid/gid 65532.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /usr/local/bin/
USER 65532:65532
EXPOSE 8080
# The server listens on 127.0.0.1 by default; containers must set HTTP_ADDR=:8080.
ENTRYPOINT ["/usr/local/bin/server"]
