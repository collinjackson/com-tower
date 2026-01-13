#!/bin/bash
# Extract Signal group IDs from Signal Desktop's database
# 
# Usage: ./get-signal-group-id.sh [group-name-pattern]
#
# Note: Signal Desktop must be CLOSED for this to work (database is locked while running)

SIGNAL_DB="$HOME/Library/Application Support/Signal/sql/db.sqlite"

if [ ! -f "$SIGNAL_DB" ]; then
  echo "Error: Signal database not found at: $SIGNAL_DB"
  echo "Make sure Signal Desktop is installed and has been used."
  exit 1
fi

# Check if database is locked
if ! sqlite3 "$SIGNAL_DB" "SELECT 1;" 2>/dev/null; then
  echo "Error: Cannot access Signal database. It may be locked."
  echo ""
  echo "Please CLOSE Signal Desktop completely, then run this script again."
  echo ""
  echo "To close Signal Desktop:"
  echo "  1. Quit Signal Desktop (Cmd+Q or right-click dock icon -> Quit)"
  echo "  2. Wait a few seconds"
  echo "  3. Run this script again"
  exit 1
fi

echo "Reading Signal groups from database..."
echo ""

# Try to find groups - Signal Desktop uses different table structures
# Common table names: conversations, groups, items

# First, list all tables
echo "Available tables:"
sqlite3 "$SIGNAL_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null | head -20
echo ""

# Try to find group data in conversations table (most common)
echo "Trying conversations table..."
sqlite3 "$SIGNAL_DB" "SELECT name, groupId FROM conversations WHERE type = 'group' LIMIT 10;" 2>/dev/null

echo ""
echo "If you see group IDs above, copy the one you need (format: group.xxxxx...)"
echo ""
echo "Alternative: Use the Signal bridge API (bot must be in the group):"
echo "  curl https://com-tower-worker-33713971134.us-central1.run.app/list-groups"
