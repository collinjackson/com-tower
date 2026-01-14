#!/bin/bash
# Get Signal group IDs from the Signal bridge API
# This works even when Signal Desktop is running!
#
# Usage: ./get-group-id-from-bridge.sh

WORKER_URL="https://com-tower-worker-33713971134.us-central1.run.app"

echo "Fetching groups from Signal bridge..."
echo ""

RESPONSE=$(curl -s --max-time 35 "${WORKER_URL}/list-groups")

if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
  echo "Error from API:"
  echo "$RESPONSE" | jq -r '.error'
  echo ""
  echo "The Signal bridge may be slow or unavailable."
  echo "Alternative: Close Signal Desktop and run: ./get-signal-group-id.sh"
  exit 1
fi

GROUPS=$(echo "$RESPONSE" | jq '.groups // []')
COUNT=$(echo "$RESPONSE" | jq '.groups // [] | length')

if [ "$COUNT" -eq 0 ]; then
  echo "No groups found. This could mean:"
  echo "  1. The bot isn't in any groups yet"
  echo "  2. The API request timed out (Signal bridge can be slow)"
  echo ""
  echo "Alternative methods:"
  echo "  1. Close Signal Desktop and run: ./get-signal-group-id.sh"
  echo "  2. Use the web UI 'Load groups' button (may also be slow)"
  echo "  3. Get the group ID from Signal Desktop manually:"
  echo "     - Close Signal Desktop"
  echo "     - Run: sqlite3 ~/Library/Application\\ Support/Signal/sql/db.sqlite \"SELECT name, groupId FROM conversations WHERE type = 'group';\""
  exit 0
fi

echo "Groups found: $COUNT"
echo ""
echo "$GROUPS" | jq -r '.[] | 
  "Name: " + (.name // "(unnamed)") + "\n" +
  "ID: " + (.id // (if .internal_id then "group." + (.internal_id | tostring) else "unknown" end)) + "\n" +
  "---"
'

echo ""
echo "Copy the group ID (starts with 'group.') and use it in the web UI."
