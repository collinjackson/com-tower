# How to Get Signal Group ID

## Method 1: Extract from Signal Desktop Database (Recommended)

1. **Close Signal Desktop completely** (Cmd+Q or right-click dock icon -> Quit)
2. **Wait a few seconds** for the database to unlock
3. **Run the script:**
   ```bash
   cd com-tower
   ./get-signal-group-id.sh
   ```
4. **Look for your group** in the output - it will show group IDs in format `group.xxxxx...`
5. **Copy the group ID** and paste it into the web UI

## Method 2: Use Signal Bridge API (Bot must be in group)

If the bot is already in the group, you can list groups via the API:

```bash
curl https://com-tower-worker-33713971134.us-central1.run.app/list-groups
```

This will show all groups the bot is in, with their IDs and names.

## Method 3: Use signal-cli directly

If you have signal-cli installed locally:

```bash
signal-cli -u +YOUR_BOT_NUMBER listGroups
```

## Setting Up Player-to-Phone Mapping

Once you have the group ID and members:

1. In the web UI, when adding a group subscriber:
   - Enter the group ID (starts with `group.`)
   - The system will fetch all members automatically
   - You can then map AWBW usernames to Signal phone numbers

2. The mapping is stored per-subscriber, so each game can have different mappings if needed.

3. When a turn notification comes in:
   - The system looks up the AWBW username from the NextTurn event
   - Finds their Signal phone number from the mapping
   - Only @-mentions that person (not all group members)
