#!/bin/sh
# Bind-mounted ./data is usually owned by the host user; make it writable for the unprivileged app user, then drop root.
set -e
chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
exec su-exec node "$@"
