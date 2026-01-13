#!/bin/bash
# Helper script to get group members from Signal group ID
# Usage: ./get-group-members.sh <groupId>

if [ -z "$1" ]; then
  echo "Usage: $0 <groupId>"
  echo ""
  echo "To get the group ID from Signal Desktop:"
  echo "1. Open Signal Desktop"
  echo "2. Right-click on the group chat"
  echo "3. Select 'Group info' or 'View group'"
  echo "4. Look for the Group ID (it's usually a long base64 string or starts with 'group.')"
  echo ""
  echo "Example: $0 group.abc123xyz..."
  exit 1
fi

GROUP_ID="$1"
WORKER_URL="https://com-tower-worker-33713971134.us-central1.run.app"

echo "Fetching members for group: $GROUP_ID"
echo ""

curl -s "${WORKER_URL}/group-members?groupId=${GROUP_ID}" | jq -r '
  if .error then
    "Error: " + .error
  else
    "Group: " + .groupName + "\n" +
    "Members (" + (.members | length | tostring) + "):\n" +
    (.members | .[] | "  - " + .)
  end
'

echo ""
echo ""
echo "To use these as mentions, copy the phone numbers above and paste them"
echo "into the 'Group mentions' field when adding the subscriber (comma-separated)."
