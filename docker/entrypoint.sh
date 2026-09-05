#!/bin/sh
# ExtensionLab container entrypoint.
#
# - Runs pending database migrations when RUN_MIGRATIONS=1 (explicit opt-in;
#   the default is to fail closed and let operators run `npm run db:migrate`).
# - Never prints environment variables or secrets.
set -eu

if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  echo "[entrypoint] applying database migrations"
  node scripts/db-migrate.mjs
fi

exec "$@"
