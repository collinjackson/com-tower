// Load-test orchestrator. Runs INSIDE `firebase emulators:exec` (so FIRESTORE_EMULATOR_HOST is
// set and Firestore is fully local/offline). For each game count G in GAMES it: seeds G active
// groupGames, spawns the bot pointed at the local mocks, waits for all G sockets to connect,
// drives ROUNDS of turns at TURN_INTERVAL_MS, then tears down and reports:
//   delivered / dropped / duplicate sends, emit->send latency (p50/p95/max), peak bot RSS.
// A G "passes" if drops==0, p95<=SLO_MS, and peak RSS<=MEM_CEILING_MB. Reports the max passing G.
//
// Zero cloud: emulator + local mock servers + local bot process(es). See README.md.
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { startAwbwMock, startRenderStub, startBridgeStub } from './mocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_ENTRY = path.join(HERE, '..', 'dist', 'index.js');

const cfg = {
  games: (process.env.GAMES || '25,50,100,200').split(',').map((s) => Number(s.trim())).filter(Boolean),
  rounds: Number(process.env.ROUNDS || '10'),
  turnIntervalMs: Number(process.env.TURN_INTERVAL_MS || '1000'),
  scalingMode: process.env.SCALING_MODE || 'singleton',
  replicas: Number(process.env.REPLICAS || '1'),
  bridgeLatencyMs: Number(process.env.BRIDGE_LATENCY_MS || '0'),
  sloMs: Number(process.env.SLO_MS || '5000'),
  memCeilingMb: Number(process.env.MEM_CEILING_MB || '450'), // per-pod ~ the Cloud Run 512Mi budget
  projectId: process.env.LOADTEST_PROJECT || 'demo-comtower',
  // leader failover test: kill the leader mid-run and measure handover
  failover: process.env.FAILOVER === '1',
  leaderTtlMs: Number(process.env.LEADER_TTL_MS || '6000'),
  leaderRenewMs: Number(process.env.LEADER_RENEW_MS || '2000'),
  ports: { awbw: 9101, render: 9102, bridge: 9103, botHealth: 9190 },
};

if (!fs.existsSync(BOT_ENTRY)) {
  console.error(`Bot build not found at ${BOT_ENTRY}. Run \`npm run build\` in bot/ first.`);
  process.exit(1);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST not set — run via `firebase emulators:exec ... "node loadtest/run.mjs"`.');
  process.exit(1);
}

initializeApp({ projectId: cfg.projectId });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until sends stop arriving (3s of no new sends), bounded by maxMs — so a slow latency tail
// is measured as latency, not miscounted as a drop when we close the mock.
async function drainQuiesce(bridge, maxMs) {
  const end = Date.now() + maxMs;
  let last = -1, stable = 0;
  while (Date.now() < end) {
    await sleep(1000);
    const n = bridge.count();
    if (n === last) { if (++stable >= 3) break; } else { stable = 0; last = n; }
  }
}
const gameIdFor = (i) => String(100000 + i);
const groupIdFor = (i) => `grp-${i}`;

async function clearGroupGames() {
  const snap = await db.collection('groupGames').get();
  let batch = db.batch();
  let n = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
}

async function seedGames(g) {
  let batch = db.batch();
  let n = 0;
  for (let i = 0; i < g; i++) {
    batch.set(db.collection('groupGames').doc(groupIdFor(i)), {
      groupId: groupIdFor(i),
      gameId: gameIdFor(i),
      status: 'active',
      players: {},
      funEnabled: false,
    });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
}

function spawnBot(index, replicas, logPath) {
  const env = {
    ...process.env,
    SCALING_MODE: cfg.scalingMode,
    AWBW_WS_BASE: `ws://127.0.0.1:${cfg.ports.awbw}`,
    AWBW_HTTP_BASE: `http://127.0.0.1:${cfg.ports.awbw}`,
    NOTIFY_RENDER_URL: `http://127.0.0.1:${cfg.ports.render}/api/notify/render`,
    SIGNAL_CLI_URL: `http://127.0.0.1:${cfg.ports.bridge}`,
    SIGNAL_CLI_NO_AUTH: '1',
    SIGNAL_BOT_NUMBER: '+10000000000',
    FIREBASE_PROJECT_ID: cfg.projectId,
    GOOGLE_CLOUD_PROJECT: cfg.projectId,
    PORT: String(cfg.ports.botHealth + index),
    HOSTNAME: `replica-${index}`, // shard-index fallback + leader id prefix
  };
  if (cfg.scalingMode === 'shard') {
    env.SHARD_INDEX = String(index);
    env.SHARD_COUNT = String(replicas);
  }
  if (cfg.scalingMode === 'leader') {
    env.LEADER_ID = `replica-${index}`;
    env.LEADER_TTL_MS = String(cfg.leaderTtlMs);
    env.LEADER_RENEW_MS = String(cfg.leaderRenewMs);
  }
  const out = fs.openSync(logPath, 'w');
  const child = spawn('node', [BOT_ENTRY], { env, stdio: ['ignore', out, out] });
  child._replicaIndex = index;
  return child;
}

async function currentLeaderId() {
  try {
    const snap = await db.collection('_locks').doc('leader').get();
    const d = snap.data();
    return d && (d.expiresAt ?? 0) > Date.now() ? d.holder || null : null;
  } catch {
    return null;
  }
}

function sampleRssMb(pid) {
  try {
    const kb = Number(execSync(`ps -o rss= -p ${pid}`).toString().trim());
    return kb / 1024;
  } catch {
    return 0;
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Match sends to emits per game in time order: each send consumes the oldest pending emit; a send
// with no pending emit is a duplicate; emits left pending at the end are drops.
function computeMetrics(emits, sends) {
  const byGame = new Map();
  for (const e of emits) (byGame.get(e.gameId) || byGame.set(e.gameId, { emits: [], sends: [] }).get(e.gameId)).emits.push(e.t);
  for (const s of sends) {
    if (!s.gameId) continue;
    (byGame.get(s.gameId) || byGame.set(s.gameId, { emits: [], sends: [] }).get(s.gameId)).sends.push(s.t);
  }
  let delivered = 0, drops = 0, dupes = 0;
  const latencies = [];
  for (const { emits: es, sends: ss } of byGame.values()) {
    es.sort((a, b) => a - b); ss.sort((a, b) => a - b);
    const pending = [...es];
    for (const st of ss) {
      // oldest pending emit at or before this send
      let idx = -1;
      for (let k = 0; k < pending.length; k++) { if (pending[k] <= st) { idx = k; break; } }
      if (idx >= 0) { latencies.push(st - pending[idx]); pending.splice(idx, 1); delivered++; }
      else dupes++;
    }
    drops += pending.length;
  }
  latencies.sort((a, b) => a - b);
  return {
    emitted: emits.length, sends: sends.length, delivered, drops, dupes,
    p50: pct(latencies, 50), p95: pct(latencies, 95), max: latencies[latencies.length - 1] || 0,
  };
}

const emitRound = (awbw, g, day, emits) => {
  for (let i = 0; i < g; i++) {
    if (awbw.emitTurn(gameIdFor(i), day)) emits.push({ gameId: gameIdFor(i), t: Date.now() });
  }
};

async function runOne(g) {
  const R = cfg.replicas;
  const tag = `${cfg.scalingMode}${R > 1 ? `x${R}` : ''}${cfg.failover ? '+failover' : ''}`;
  console.log(`\n=== G=${g} games | mode=${tag} | ${cfg.rounds} rounds @ ${cfg.turnIntervalMs}ms ===`);
  await clearGroupGames();
  await seedGames(g);

  const awbw = startAwbwMock({ port: cfg.ports.awbw });
  const render = startRenderStub({ port: cfg.ports.render });
  const bridge = startBridgeStub({ port: cfg.ports.bridge, latencyMs: cfg.bridgeLatencyMs });

  const bots = [];
  for (let i = 0; i < R; i++) bots.push(spawnBot(i, R, path.join(HERE, `bot-${tag}-g${g}-r${i}.log`)));
  const peakPerPod = new Array(R).fill(0);
  const rssTimer = setInterval(() => {
    for (let i = 0; i < R; i++) if (bots[i] && !bots[i].killed) peakPerPod[i] = Math.max(peakPerPod[i], sampleRssMb(bots[i].pid));
  }, 500);

  // Wait until a socket is open for every game (bounded). Across replicas each game has one owner.
  const deadline = Date.now() + 60000;
  while (awbw.gamesConnected() < g && Date.now() < deadline) await sleep(250);
  const connected = awbw.gamesConnected();
  if (connected < g) console.warn(`  ! only ${connected}/${g} sockets connected before driving load`);

  const emits = [];
  let failover = null;
  if (cfg.failover && cfg.scalingMode === 'leader') {
    const preKill = Math.max(2, Math.floor(cfg.rounds / 3));
    let day = 0;
    for (; day < preKill; day++) { emitRound(awbw, g, day + 1, emits); await sleep(cfg.turnIntervalMs); }
    const leaderId = await currentLeaderId();
    const victim = bots.find((b) => `replica-${b._replicaIndex}` === leaderId);
    const killAt = Date.now();
    if (victim) { console.log(`  ! killing leader ${leaderId} (pid ${victim.pid}) to force failover`); victim.kill('SIGKILL'); }
    else console.warn(`  ! no live leader found to kill (holder=${leaderId})`);
    // Keep emitting THROUGH the handover so we actually observe the new leader resume. Stop a few
    // rounds after the first post-kill send, bounded so a stuck failover can't hang the run.
    const maxT = Date.now() + Math.max(cfg.leaderTtlMs * 4, 20000);
    let extraAfterRecovery = 0;
    while (Date.now() < maxT) {
      emitRound(awbw, g, ++day, emits);
      await sleep(cfg.turnIntervalMs);
      if (bridge.sends.some((s) => s.t > killAt)) { if (++extraAfterRecovery >= 3) break; }
    }
    await drainQuiesce(bridge, Math.max(15000, g * 20));
    const firstAfter = bridge.sends.filter((s) => s.t > killAt).sort((a, b) => a.t - b.t)[0];
    const newLeader = await currentLeaderId();
    failover = {
      killedLeader: leaderId,
      newLeader,
      recoveredLeadership: !!newLeader && newLeader !== leaderId,
      recoveryMs: firstAfter ? firstAfter.t - killAt : null,
    };
  } else {
    for (let round = 1; round <= cfg.rounds; round++) { emitRound(awbw, g, round, emits); await sleep(cfg.turnIntervalMs); }
    await drainQuiesce(bridge, Math.max(15000, g * 20, cfg.bridgeLatencyMs * 4));
  }

  clearInterval(rssTimer);
  for (const b of bots) { try { b.kill('SIGTERM'); } catch {} }
  await sleep(500);
  for (const b of bots) { try { b.kill('SIGKILL'); } catch {} }
  await Promise.all([awbw.close(), render.close(), bridge.close()]);

  const m = computeMetrics(emits, bridge.sends);
  const maxPodRss = Math.max(...peakPerPod);
  // In failover we EXPECT a handover gap (drops), so don't fail on drops there; dupes must stay 0.
  const pass = cfg.failover
    ? m.dupes === 0 && failover?.recoveredLeadership === true
    : m.drops === 0 && m.dupes === 0 && m.p95 <= cfg.sloMs && maxPodRss <= cfg.memCeilingMb;
  console.log(
    `  connected=${connected}/${g} emitted=${m.emitted} delivered=${m.delivered} ` +
    `drops=${m.drops} dupes=${m.dupes} | latency p50=${m.p50}ms p95=${m.p95}ms max=${m.max}ms | ` +
    `maxPodRSS=${maxPodRss.toFixed(0)}MB (per-pod=[${peakPerPod.map((x) => x.toFixed(0)).join(',')}]) | ${pass ? 'PASS' : 'FAIL'}`
  );
  if (failover) console.log(`  failover: killed=${failover.killedLeader} -> new=${failover.newLeader} recovered=${failover.recoveredLeadership} recovery=${failover.recoveryMs}ms drops(gap)=${m.drops}`);
  return { g, connected, ...m, maxPodRssMb: Math.round(maxPodRss), perPodRss: peakPerPod.map((x) => Math.round(x)), failover, pass };
}

const results = [];
for (const g of cfg.games) results.push(await runOne(g));

const passing = results.filter((r) => r.pass).map((r) => r.g);
const maxPass = passing.length ? Math.max(...passing) : 0;
console.log(`\n=== SUMMARY (mode=${cfg.scalingMode}) ===`);
console.log(`max sustained clients (games) meeting SLO: ${maxPass}`);
console.table(results.map((r) => ({
  G: r.g, connected: r.connected, delivered: r.delivered, drops: r.drops, dupes: r.dupes,
  p50: r.p50, p95: r.p95, max: r.max, maxPodRSS_MB: r.maxPodRssMb, pass: r.pass,
})));

const outPath = path.join(HERE, `results-${cfg.scalingMode}.json`);
fs.writeFileSync(outPath, JSON.stringify({ config: cfg, results, maxPass }, null, 2));
console.log(`wrote ${outPath}`);
process.exit(0);
