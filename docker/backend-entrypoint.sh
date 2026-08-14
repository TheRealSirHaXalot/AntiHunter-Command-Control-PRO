#!/bin/sh
set -eu

# BusyBox / dash do not support pipefail. Only enable when available.
if [ -n "${BASH:-}" ]; then
  set -o pipefail
fi

# Ensure git considers /app safe regardless of mounted volume ownership
git config --global --add safe.directory /app || true

cd /app/apps/backend

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running database migrations..."
  npx prisma migrate deploy
fi

echo "Running database seed..."
if [ -f dist/seed.js ]; then
  node dist/seed.js
elif [ -f dist/prisma/seed.js ]; then
  node dist/prisma/seed.js
else
  echo "Seed file not found at dist/seed.js or dist/prisma/seed.js, skipping seed execution."
fi

echo "Starting backend..."
exec node dist/main.js
