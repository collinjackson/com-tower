#!/usr/bin/env node
/**
 * Extract Signal group IDs from Signal Desktop's local database
 * 
 * Usage: node extract-group-id.js [group-name-pattern]
 * 
 * This script reads Signal Desktop's SQLite database to find group IDs.
 * On macOS, the database is at: ~/Library/Application Support/Signal/sql/db.sqlite
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SIGNAL_DB_PATH = path.join(
  process.env.HOME,
  'Library/Application Support/Signal/sql/db.sqlite'
);

function findGroupId(groupNamePattern) {
  if (!fs.existsSync(SIGNAL_DB_PATH)) {
    console.error(`Signal database not found at: ${SIGNAL_DB_PATH}`);
    console.error('Make sure Signal Desktop is installed and has been used at least once.');
    process.exit(1);
  }

  try {
    // Try to query the database
    // Signal Desktop uses different table names - let's try common ones
    const queries = [
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%group%';",
      "SELECT name FROM sqlite_master WHERE type='table';",
    ];

    let tables = [];
    for (const query of queries) {
      try {
        const result = execSync(
          `sqlite3 "${SIGNAL_DB_PATH}" "${query}"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.trim()) {
          tables = result.trim().split('\n').filter(t => t);
          break;
        }
      } catch (err) {
        // Continue to next query
      }
    }

    if (tables.length === 0) {
      console.error('Could not read Signal database. It may be locked (close Signal Desktop first).');
      console.error('\nAlternative: Use the Signal bridge API to list groups:');
      console.error('  curl https://com-tower-worker-33713971134.us-central1.run.app/list-groups');
      process.exit(1);
    }

    console.log('Found tables:', tables.join(', '));
    console.log('\nTrying to find groups...\n');

    // Try to find groups in common table structures
    const groupQueries = [
      // Try conversations table (common in Signal Desktop)
      `SELECT id, name, groupId FROM conversations WHERE type = 'group' LIMIT 20;`,
      // Try groups table
      `SELECT id, name, groupId FROM groups LIMIT 20;`,
      // Try a generic query
      `SELECT * FROM sqlite_master WHERE type='table';`,
    ];

    for (const query of groupQueries) {
      try {
        const result = execSync(
          `sqlite3 "${SIGNAL_DB_PATH}" -json "${query}"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.trim()) {
          console.log('Query result:');
          console.log(result);
          break;
        }
      } catch (err) {
        // Continue
      }
    }

    console.log('\nIf the above didn\'t show group IDs, try:');
    console.log('1. Close Signal Desktop completely');
    console.log('2. Run: sqlite3 ~/Library/Application\\ Support/Signal/sql/db.sqlite ".tables"');
    console.log('3. Then query the groups/conversations table manually');
    console.log('\nOr use the Signal bridge API (bot must be in the group):');
    console.log('  curl https://com-tower-worker-33713971134.us-central1.run.app/list-groups');

  } catch (err) {
    console.error('Error:', err.message);
    console.error('\nThe database may be locked. Try closing Signal Desktop first.');
    process.exit(1);
  }
}

const groupNamePattern = process.argv[2];
findGroupId(groupNamePattern);
