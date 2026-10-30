#!/usr/bin/env bash
set -euo pipefail

echo "==> Building frontend..."
cd frontend
npm ci --no-audit --no-fund
npm run build
cd ..

echo "==> Preparing embedded frontend assets..."
mkdir -p cmd/server/frontend_dist
rm -rf cmd/server/frontend_dist/*
cp -r frontend/dist/* cmd/server/frontend_dist/

echo "==> Building Go server..."
go build -trimpath -ldflags="-s -w" -o server ./cmd/server

echo "==> Build complete."
