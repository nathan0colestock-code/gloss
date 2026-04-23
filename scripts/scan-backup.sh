#!/usr/bin/env bash
# Daily backup of /app/data/scans to R2 (nathan-suite-backups/gloss-scans).
#
# Called by the setInterval loop in server.js (once per 24h) via child_process.
# Can also be run manually on the Fly machine for one-off syncs:
#   fly ssh console -a gloss-nc -C "/app/scripts/scan-backup.sh"
#
# Requires: rclone installed (Dockerfile does this), plus the R2_* env vars
# from Wave 2 secrets. If any of those are missing we exit 0 with a log —
# the interval loop shouldn't flap because credentials haven't landed yet.
set -u

SCANS_DIR="${SCANS_DIR:-/app/data/scans}"
BUCKET="${SCANS_BUCKET:-nathan-suite-backups}"
PREFIX="${SCANS_PREFIX:-gloss-scans}"

if [[ -z "${R2_ENDPOINT:-}" || -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  echo "[scan-backup] R2_* env vars not set — skipping sync"
  exit 0
fi

if [[ ! -d "$SCANS_DIR" ]]; then
  echo "[scan-backup] scans dir missing: $SCANS_DIR — skipping"
  exit 0
fi

# Generate a minimal rclone config on the fly rather than baking credentials
# into the image. The config uses the "s3" backend pointed at R2's S3-compat
# endpoint.
RCLONE_CONFIG="$(mktemp)"
trap 'rm -f "$RCLONE_CONFIG"' EXIT
cat > "$RCLONE_CONFIG" <<EOF
[r2]
type = s3
provider = Cloudflare
endpoint = ${R2_ENDPOINT}
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
region = auto
acl = private
EOF

echo "[scan-backup] syncing $SCANS_DIR → r2:${BUCKET}/${PREFIX}/"
rclone --config "$RCLONE_CONFIG" sync "$SCANS_DIR" "r2:${BUCKET}/${PREFIX}/" \
  --fast-list --transfers 4 --checkers 8 \
  --s3-no-check-bucket \
  --stats 0
status=$?
if [[ $status -eq 0 ]]; then
  echo "[scan-backup] sync ok"
else
  echo "[scan-backup] sync FAILED (rclone exit $status)"
fi
exit $status
