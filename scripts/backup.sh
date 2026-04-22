#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_SRC="$REPO_DIR/data/foxed.db"
BACKUP_ROOT="/Users/nathancolestock/Documents/gloss_backup"
KEEP_DAYS=7

DATE="$(date +%Y-%m-%d)"
DEST="$BACKUP_ROOT/$DATE"

mkdir -p "$DEST"

# Consistent DB snapshot via SQLite backup API (safe with WAL mode)
sqlite3 "$DB_SRC" ".backup '$DEST/foxed.db'"

# Sync file dirs (incremental, delete files removed from source)
rsync -a --delete "$REPO_DIR/data/scans/"      "$DEST/scans/"
rsync -a --delete "$REPO_DIR/data/artifacts/"  "$DEST/artifacts/"
rsync -a --delete "$REPO_DIR/data/references/" "$DEST/references/"

echo "$(date -Iseconds) backup complete → $DEST" >> "$BACKUP_ROOT/backup.log"

# Prune backups older than KEEP_DAYS
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '????-??-??' | sort | head -n "-$KEEP_DAYS" | while read -r old; do
  rm -rf "$old"
  echo "$(date -Iseconds) pruned $old" >> "$BACKUP_ROOT/backup.log"
done
