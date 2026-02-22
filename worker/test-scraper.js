// Test script to verify scraper logic for all tracked games
import https from 'https';

function gameLink(gameId) {
  return `https://awbw.amarriner.com/game.php?games_id=${gameId}`;
}

async function scrapeCurrentPlayerName(gameId) {
  return new Promise((resolve) => {
    const url = gameLink(gameId);
    https.get(url, (res) => {
      let html = '';
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => {
        // Try multiple patterns we have seen on AWBW pages
        const patterns = [
          /currentplayer["']?\s*[:=]\s*["']([^"']+)["']/i, // JS variable
          /currentPlayer["']?\s*[:=]\s*["']([^"']+)["']/i, // camelCase variant
          /Current\s+Turn[^<]*profile\.php\?username=([^"'>\s]+)/i, // Current Turn: link
          /profile\.php\?username=([A-Za-z0-9_]+)[^<]{0,60}(?:['']|&rsquo;|&#8217;|&#039;|&apos;)s\s+turn/i, // "<name>'s turn" with straight/curly/entity apostrophes
        ];
        for (const pat of patterns) {
          const m = html.match(pat);
          if (m && m[1]) {
            resolve(m[1]);
            return;
          }
        }

        // Fallback: parse currentTurn and playersInfo blob
        const currentTurnMatch = html.match(/let\s+currentTurn\s*=\s*(\d+)/);
        const playersInfoMatch = html.match(/let\s+playersInfo\s*=\s*(\{[\s\S]*?\});/);
        if (currentTurnMatch && playersInfoMatch) {
          try {
            const pid = currentTurnMatch[1];
            const jsonText = playersInfoMatch[1];
            const playersInfo = JSON.parse(jsonText);
            const name = playersInfo?.[pid]?.users_username;
            if (name) {
              resolve(name);
              return;
            }
          } catch (err) {
            console.error(`Game ${gameId}: playersInfo parse failed`, err.message);
          }
        }
        resolve(undefined);
      });
    }).on('error', (err) => {
      console.error(`Game ${gameId}: fetch failed`, err.message);
      resolve(undefined);
    });
  });
}

// Test games - add more as needed
const testGames = [
  '1580168', // The game the user mentioned
  '1582490', // Another game from the user's message
  '1578803', // Another game mentioned
];

async function testAll() {
  console.log('Testing scraper on tracked games...\n');
  for (const gameId of testGames) {
    const playerName = await scrapeCurrentPlayerName(gameId);
    const status = playerName ? '✓' : '✗';
    console.log(`${status} Game ${gameId}: ${playerName || 'FAILED TO DETECT'}`);
    // Small delay to avoid hammering the server
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

testAll().catch(console.error);
