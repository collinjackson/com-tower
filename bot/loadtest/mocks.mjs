// Local mock servers that stand in for the bot's external dependencies during load tests, so we
// can measure the bot in isolation with zero cloud. Each returns a handle with metrics + close().
//
//   AWBW mock   (one port): serves both the game-page HTTP scrape and the per-game websocket that
//               emits NextTurn. This is the load driver.
//   Render stub:            returns { text } instantly (the dashboard notify/render endpoint).
//   Bridge stub:            accepts POST /v2/send and records every send (the Signal bridge).
import http from 'http';
import { WebSocketServer } from 'ws';

// --- AWBW mock: HTTP scrape + per-game websocket -----------------------------------------------
export function startAwbwMock({ port }) {
  const conns = new Map(); // gameId -> Set<ws>
  const server = http.createServer((req, res) => {
    // Scrape endpoint. Return benign HTML with no parseable turn state — the bot degrades
    // gracefully (falls back to the websocket-supplied player), which still exercises the full
    // render->send pipeline. Never signals "game over".
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><!-- loadtest awbw stub --></body></html>');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const m = /\/node\/game\/([^/?]+)/.exec(req.url || '');
    if (!m) return socket.destroy();
    const gameId = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!conns.has(gameId)) conns.set(gameId, new Set());
      conns.get(gameId).add(ws);
      ws.on('message', () => {}); // ignore the bot's empty-string keepalives
      ws.on('close', () => conns.get(gameId)?.delete(ws));
      ws.on('error', () => {});
    });
  });

  server.listen(port);
  return {
    gamesConnected: () => [...conns.values()].filter((s) => s.size > 0).length,
    socketCount: () => [...conns.values()].reduce((a, s) => a + s.size, 0),
    // Push a NextTurn to every socket watching this game. `day` increments each turn so the bot's
    // dedup key changes and every emit is processed. Returns true if at least one socket got it.
    emitTurn(gameId, day) {
      const set = conns.get(gameId);
      if (!set || set.size === 0) return false;
      const msg = JSON.stringify({ NextTurn: { day, nextPId: day, playerName: `player${day % 4}` } });
      for (const ws of set) { try { ws.send(msg); } catch {} }
      return true;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// --- Render stub -------------------------------------------------------------------------------
export function startRenderStub({ port }) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'Your turn!' }));
    });
  });
  server.listen(port);
  return { count: () => count, close: () => new Promise((r) => server.close(r)) };
}

// --- Signal bridge stub ------------------------------------------------------------------------
export function startBridgeStub({ port, latencyMs = 0 }) {
  const sends = []; // { t, recipient, gameId }
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url || '').startsWith('/v2/send')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const deliver = () => {
          // The bot appends the game link to the message; recover gameId from games_id=NNN.
          const gid = /games_id=(\d+)/.exec(parsed.message || '')?.[1];
          sends.push({ t: Date.now(), recipient: (parsed.recipients || [])[0], gameId: gid });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamp: Date.now() }));
        };
        latencyMs > 0 ? setTimeout(deliver, latencyMs) : deliver();
      });
    } else {
      // /v1/groups and friends — return an empty list so any lookups succeed harmlessly.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
  });
  server.listen(port);
  return { sends, count: () => sends.length, close: () => new Promise((r) => server.close(r)) };
}
