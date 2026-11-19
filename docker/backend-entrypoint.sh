#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  node_uid=$(id -u node)
  for dir in /app/data/matter /app/data/tiles /app/apps/backend/.secrets; do
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "$node_uid" ]; then
      chown -R node:node "$dir"
    fi
  done
  groups=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, -)
  if [ -n "$groups" ]; then
    exec env HOME=/home/node setpriv --reuid=node --regid=node --groups="$groups" "$0" "$@"
  fi
  exec env HOME=/home/node setpriv --reuid=node --regid=node --clear-groups "$0" "$@"
fi

# BusyBox / dash do not support pipefail. Only enable when available.
if [ -n "${BASH:-}" ]; then
  set -o pipefail
fi

# Ensure git considers /app safe regardless of mounted volume ownership
git config --global --add safe.directory /app || true

cd /app/apps/backend

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running database migrations..."
  AHCC_PRISMA_CMD="/app/apps/backend/node_modules/.bin/prisma" node /app/scripts/db-update-helper.mjs
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
