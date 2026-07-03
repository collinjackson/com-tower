// Standalone mock-server process: hosts the AWBW ws+http mock, the render stub, and the bridge
// stub, plus a small control API the orchestrator drives over HTTP. Running these in their OWN
// process means they don't share the orchestrator's event loop with the load driver / metrics —
// which is what manufactured latency and drops at high replica counts. Emit and send timestamps
// are taken HERE (co-located), so latency = send.t - emit.t on one clock.
import http from 'http';
import { startAwbwMock, startRenderStub, startBridgeStub } from './mocks.mjs';

const P = {
  awbw: Number(process.env.AWBW_PORT || 9101),
  render: Number(process.env.RENDER_PORT || 9102),
  bridge: Number(process.env.BRIDGE_PORT || 9103),
  control: Number(process.env.CONTROL_PORT || 9200),
};
const gameIdFor = (i) => String(100000 + i);

const awbw = startAwbwMock({ port: P.awbw });
const render = startRenderStub({ port: P.render });
const bridge = startBridgeStub({ port: P.bridge, latencyMs: Number(process.env.BRIDGE_LATENCY_MS || 0) });
let emits = [];

const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/control/connected') return json({ connected: awbw.gamesConnected() });
  if (url.pathname === '/control/reset' && req.method === 'POST') { emits = []; bridge.sends.length = 0; return json({ ok: true }); }
  if (url.pathname === '/control/emit-round' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { g, day } = JSON.parse(body || '{}');
      let n = 0;
      for (let i = 0; i < g; i++) if (awbw.emitTurn(gameIdFor(i), day)) { emits.push({ gameId: gameIdFor(i), t: Date.now() }); n++; }
      json({ emitted: n });
    });
    return;
  }
  if (url.pathname === '/control/stats') return json({ emits, sends: bridge.sends, renderCount: render.count() });
  res.writeHead(404); res.end();
});
control.listen(P.control, () => console.log(`[mock-server] control:${P.control} awbw:${P.awbw} render:${P.render} bridge:${P.bridge}`));
