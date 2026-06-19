#!/bin/bash
# Extract Signal group ID from a group invite link
#
# Usage: ./extract-group-id-from-link.sh <signal-group-link>
#
# Signal group links look like: https://signal.group/#CjQKICLkMKbor17qZpL-qxyeZWwqxSAZk3fNNwwMMLcvhwi2EhBszH85V-3MGzYVnzSuB67W
# The group ID is the base64-encoded part after the #

if [ -z "$1" ]; then
  echo "Usage: $0 <signal-group-link>"
  echo ""
  echo "Example:"
  echo "  $0 'https://signal.group/#CjQKICLkMKbor17qZpL-qxyeZWwqxSAZk3fNNwwMMLcvhwi2EhBszH85V-3MGzYVnzSuB67W'"
  echo ""
  echo "To get a group link from Signal Desktop:"
  echo "  1. Open the group chat"
  echo "  2. Click on the group name"
  echo "  3. Select 'Group Link'"
  echo "  4. Enable it if needed"
  echo "  5. Click 'Share' to copy the link"
  exit 1
fi

LINK="$1"

# Extract the part after #
GROUP_ID_PART=$(echo "$LINK" | sed -n 's/.*#\(.*\)/\1/p')

if [ -z "$GROUP_ID_PART" ]; then
  echo "Error: Could not extract group ID from link."
  echo "Make sure the link contains '#' followed by the group identifier."
  exit 1
fi

# The group ID for signal-cli-rest-api is typically in format "group.<base64>"
# But we need to check what format the bridge expects
echo "Extracted group identifier: $GROUP_ID_PART"
echo ""
echo "Try using this as the group ID:"
echo "  group.$GROUP_ID_PART"
echo ""
echo "Or just the base64 part:"
echo "  $GROUP_ID_PART"
echo ""
echo "Paste one of these into the web UI when adding a group subscriber."
