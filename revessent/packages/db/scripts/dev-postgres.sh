#!/usr/bin/env bash
# Boots the local PostgreSQL 16 cluster (zonky binaries, user-space).
# Data lives in /tmp/pgdata (ephemeral by design; real deployments use
# docker-compose.yml / Neon — the spec's environments, §4.4).
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NATIVE="$(find "$ROOT/node_modules/.pnpm" -maxdepth 6 -path "*@embedded-postgres/linux-x64/native" -type d | head -1)"
export LD_LIBRARY_PATH="$NATIVE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
BIN="$NATIVE/bin"

if [ ! -d /tmp/pgdata ]; then
  mkdir -p /tmp/pgdata
  "$BIN/initdb" -D /tmp/pgdata -U postgres --auth=trust >/tmp/initdb.log 2>&1
  echo "cluster initialized"
fi
exec "$BIN/postgres" -D /tmp/pgdata -p 5433 -c listen_addresses=127.0.0.1
