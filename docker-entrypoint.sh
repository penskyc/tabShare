#!/bin/sh
# A fresh bind mount (./data) is created by Docker as root: hand it to the app's user, then drop root.
# With `user:` set in compose the container already runs unprivileged and this is skipped.
set -e
if [ "$(id -u)" = 0 ]; then
  [ "$(stat -c %u /data)" = "$(id -u node)" ] || chown -R node:node /data
  exec su-exec node "$@"
fi
exec "$@"
