# syntax=docker/dockerfile:1
# Production multi-stage Dockerfile for CollabSpace (single-origin deployment on Render).
# Builds the Vite frontend and Go server into a single minimal distroless image.

# 1. Build the frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2. Build Go binaries with embedded frontend
FROM golang:1.24-alpine AS backend-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations
# Copy Vite production build into cmd/server/frontend_dist
COPY --from=frontend-build /app/frontend/dist/ ./cmd/server/frontend_dist/
ENV CGO_ENABLED=0
RUN go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/server ./cmd/server \
 && go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/admin ./cmd/admin \
 && go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/healthcheck ./cmd/healthcheck

# 3. Minimal runtime image
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend-build /out/ /usr/local/bin/
USER 65532:65532
EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/server"]
