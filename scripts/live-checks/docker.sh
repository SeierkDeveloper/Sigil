#!/bin/sh
# The container image: build it, start it on a spare port with a throwaway
# volume, check its health, stop it and remove what it made. Needs Docker.
set -eu
PORT="${SIGIL_CHECK_PORT:-8099}"
NAME="sigil-live-check-$$"
cd "$(dirname "$0")/../.."
docker build -t sigil-node:live-check --build-arg NEXT_PUBLIC_SITE_URL="http://localhost:$PORT" .
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -v "$NAME-data:/data" sigil-node:live-check >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm "$NAME-data" >/dev/null 2>&1' EXIT
i=0
until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "FAIL  health: no answer after 60 s"; docker logs "$NAME" | tail -20; exit 1; }
  sleep 1
done
echo "PASS  health: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
docker exec "$NAME" sh -c 'test -w /data' && echo "PASS  /data is writable by the node's user" || echo "FAIL  /data is not writable (on Railway set RAILWAY_RUN_UID=0)"
echo "PASS  image size: $(docker image inspect sigil-node:live-check --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}')"
