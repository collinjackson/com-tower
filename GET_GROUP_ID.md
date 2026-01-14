# How to Get Signal Group ID

Based on Signal's design, group IDs are not easily accessible from Signal Desktop's UI or database (which is encrypted). Here are the practical methods:

## Method 1: Extract from Group Invite Link (Easiest)

1. **Get the group link from Signal Desktop:**
   - Open the group chat in Signal Desktop
   - Click on the group name (at the top)
   - Select "Group Link"
   - Enable it if it's not already enabled
   - Click "Share" to copy the link

2. **Extract the group ID:**
   ```bash
   ./extract-group-id-from-link.sh "https://signal.group/#CjQKICLkMKbor17qZpL-qxyeZWwqxSAZk3fNNwwMMLcvhwi2EhBszH85V-3MGzYVnzSuB67W"
   ```

   The group ID will be the base64 part after the `#` in the URL.

3. **Use in web UI:**
   - Paste the group ID (format: `group.xxxxx...` or just `xxxxx...`) into the "Signal phone/group link" field

## Method 2: Use Signal Bridge API (If Bot is in Group)

If the bot is already in the group, you can list groups via the API:

```bash
./get-group-id-from-bridge.sh
```

Or use the web UI "Load groups" button (may be slow/timeout).

## Method 3: Use signal-cli (If Properly Configured)

If you have `signal-cli` set up and linked to your account:

```bash
signal-cli -u +YOUR_PHONE_NUMBER listGroups
```

**Note:** This may not work if signal-cli isn't properly synced with your Signal Desktop account.

## Method 4: Signal Desktop Database (Not Recommended)

Signal Desktop's database is encrypted and not easily readable. The SQLite database at:
```
~/Library/Application Support/Signal/sql/db.sqlite
```
is encrypted and cannot be read directly with standard SQLite tools.

## Recommended Approach

**Use Method 1 (Group Invite Link)** - it's the most reliable:
1. Get the group link from Signal Desktop
2. Run the extraction script
3. Use the group ID in the web UI

The group ID format for the Signal bridge API is typically `group.<base64>` where `<base64>` is the part after `#` in the invite link.
