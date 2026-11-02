import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awbwTimeToMs,
  backfillFromReplay,
  collectTurnStarts,
  computeTurnTimes,
  formatSpan,
  replayToSnapshot,
  summarize,
  type ClockSnapshot,
} from './turn-times.ts';

const H = 3600_000;
const iso = (s: string) => Date.parse(s);

test('AWBW times are US Eastern, either side of the DST change', () => {
  // Game 1751089: el_mero_mero's day-8 turn, and onetrickwolf's after clocks went back.
  assert.equal(awbwTimeToMs('2026-10-30 08:55:13'), iso('2026-10-30T12:55:13Z'));
  assert.equal(awbwTimeToMs('2026-11-01 18:51:56'), iso('2026-11-01T23:51:56Z'));
  assert.equal(awbwTimeToMs('not a time'), undefined);
});

const roster = (extra: Record<string, object> = {}) => ({
  a: { username: 'alec', order: 1, countryCode: 'os', coName: 'Sami', ...extra.a },
  b: { username: 'eagle', order: 2, countryCode: 'bm', coName: 'Eagle', ...extra.b },
  c: { username: 'wolf', order: 5, countryCode: 'ge', coName: 'Max', ...extra.c },
});

/** A turn notification: Com Tower's own sample, timed by when it was taken. */
const notify = (day: number, pid: string, at: string, players = roster()): ClockSnapshot => ({
  day,
  turnPlayerId: pid,
  players,
  atMs: iso(at),
  source: 'notify',
});

test('times each turn from notification to the next notification', () => {
  const snaps = [
    notify(1, 'a', '2026-10-01T00:00:00Z'), // first sighting: Com Tower joining, not a turn start
    notify(1, 'b', '2026-10-01T02:00:00Z'),
    notify(1, 'c', '2026-10-01T03:00:00Z'),
    notify(2, 'a', '2026-10-01T13:00:00Z'),
    notify(2, 'b', '2026-10-03T13:00:00Z'), // alec sat on day 2 for two days
  ];
  const r = computeTurnTimes(snaps, iso('2026-10-03T14:00:00Z'));
  const by = Object.fromEntries(r.players.map((p) => [p.username, p]));
  assert.deepEqual(by.alec.turns, [{ day: 2, ms: 48 * H }]);
  assert.deepEqual(by.eagle.turns, [{ day: 1, ms: 1 * H }]);
  assert.deepEqual(by.wolf.turns, [{ day: 1, ms: 10 * H }]);
  assert.equal(by.eagle.currentMs, 1 * H);
  assert.equal(by.alec.currentMs, undefined);
  // Day 1's first start is unknown (only the join sighting), so day 1 asks for a backfill.
  assert.deepEqual(r.missingDays, [1]);
});

test('a missed notification leaves turns untimed instead of merging them', () => {
  const snaps = [
    notify(1, 'a', '2026-10-01T00:00:00Z'),
    notify(1, 'b', '2026-10-01T02:00:00Z'),
    // wolf's day-1 turn was never sampled
    notify(2, 'a', '2026-10-01T13:00:00Z'),
    notify(2, 'b', '2026-10-01T14:00:00Z'),
  ];
  const r = computeTurnTimes(snaps, iso('2026-10-01T15:00:00Z'));
  const eagle = r.players.find((p) => p.username === 'eagle')!;
  assert.deepEqual(eagle.turns, []); // not 11h: that span holds wolf's turn too
  assert.deepEqual(r.missingDays, [1]);
});

test("one AWBW reading times the whole round before it from everyone's turn starts", () => {
  // Day 8 of game 1751089, read during onetrickwolf's turn.
  const live: ClockSnapshot = {
    day: 8,
    turnPlayerId: 'c',
    source: 'live',
    players: roster({
      a: { turnStart: '2026-10-30 08:55:13' },
      b: { turnStart: '2026-10-30 18:24:47' },
      c: { turnStart: '2026-11-01 18:51:56' },
    }),
  };
  const starts = collectTurnStarts([live]);
  assert.equal(starts.get('8:c'), iso('2026-11-01T23:51:56Z'));
  const r = computeTurnTimes([live], iso('2026-11-02T01:51:56Z'));
  const by = Object.fromEntries(r.players.map((p) => [p.username, p]));
  assert.deepEqual(by.alec.turns, [{ day: 8, ms: 9 * H + 29 * 60_000 + 34_000 }]);
  assert.equal(by.eagle.turns[0].ms, iso('2026-11-01T23:51:56Z') - iso('2026-10-30T22:24:47Z'));
  assert.equal(by.wolf.currentMs, 2 * H);
});

test("players later in the order were last up the day before", () => {
  const live: ClockSnapshot = {
    day: 3,
    turnPlayerId: 'a',
    source: 'live',
    players: roster({
      a: { turnStart: '2026-10-03 10:00:00' },
      b: { turnStart: '2026-10-02 12:00:00' },
      c: { turnStart: '2026-10-02 20:00:00' },
    }),
  };
  const starts = collectTurnStarts([live]);
  assert.deepEqual([...starts.keys()].sort(), ['2:b', '2:c', '3:a']);
});

test('AWBW start wins over the notification time', () => {
  const snaps: ClockSnapshot[] = [
    notify(1, 'a', '2026-10-01T00:00:00Z'),
    notify(1, 'b', '2026-10-01T02:00:00Z'),
    {
      ...notify(1, 'c', '2026-10-01T03:00:00Z'),
      players: roster({ b: { turnStart: '2026-09-30 21:30:00' } }), // 01:30Z: 30m before we saw it
    },
  ];
  assert.equal(collectTurnStarts(snaps).get('1:b'), iso('2026-10-01T01:30:00Z'));
});

test('eliminated players drop out of the turn order', () => {
  const out = roster({ b: { eliminated: true } });
  const snaps = [
    notify(1, 'a', '2026-10-01T00:00:00Z'),
    notify(1, 'b', '2026-10-01T01:00:00Z'),
    notify(1, 'c', '2026-10-01T02:00:00Z'),
    notify(2, 'a', '2026-10-01T05:00:00Z', out),
    notify(2, 'c', '2026-10-01T09:00:00Z', out), // straight from alec to wolf: eagle is out
  ];
  const r = computeTurnTimes(snaps, iso('2026-10-01T10:00:00Z'));
  const alec = r.players.find((p) => p.username === 'alec')!;
  assert.deepEqual(alec.turns, [{ day: 2, ms: 4 * H }]);
  assert.equal(r.players.find((p) => p.username === 'eagle')!.eliminated, true);
});

test('summary statistics', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, max: 4, mean: 2.5, median: 2.5, total: 10 });
  assert.equal(summarize([5, 1, 3])!.median, 3);
  assert.equal(summarize([]), undefined);
  assert.equal(formatSpan(49 * H + 20 * 60_000), '2d 1h');
  assert.equal(formatSpan(5 * H + 12 * 60_000), '5h 12m');
  assert.equal(formatSpan(14 * 60_000), '14m');
});

/** A replay where turn index i is day floor(i/3)+1, player (a, b, c)[i % 3], 6h per turn. */
function fakeReplay(days: number) {
  const pids = ['a', 'b', 'c'];
  const startOf = (i: number) => iso('2026-10-01T04:00:00Z') + i * 6 * H; // EDT: 00:00 local
  const awbw = (ms: number) => new Date(ms - 4 * H).toISOString().slice(0, 19).replace('T', ' ');
  const requested: number[] = [];
  const fetchTurn = async (i: number) => {
    requested.push(i);
    if (i >= days * 3) return undefined; // "Requested turn has no replay stored"
    const players: Record<string, object> = {};
    pids.forEach((pid, r) => {
      // Each player's latest start at or before turn i.
      const last = i - ((i % 3) - r + 3) % 3;
      players[pid] = {
        users_username: pid,
        players_order: [1, 2, 5][r],
        players_eliminated: 'N',
        countries_code: 'os',
        co_name: 'Andy',
        players_turn_start: last >= 0 ? awbw(startOf(last)) : '2026-09-30 00:00:00',
      };
    });
    return replayToSnapshot({ day: Math.floor(i / 3) + 1, gameState: { currentTurnPId: pids[i % 3], players } });
  };
  return { fetchTurn, requested, startOf };
}

test('backfill fetches one replay turn per missing day, aimed at its last turn', async () => {
  const { fetchTurn, requested, startOf } = fakeReplay(5);
  // Com Tower only saw day 4 onwards.
  const iso2 = (i: number) => new Date(startOf(i)).toISOString();
  const snaps = [9, 10, 11, 12].map((i) => notify(Math.floor(i / 3) + 1, ['a', 'b', 'c'][i % 3], iso2(i)));
  const added = await backfillFromReplay(snaps, fetchTurn, { delayMs: 0, nowMs: startOf(12) + H });
  assert.deepEqual(requested, [2, 5, 8, 11]); // last turn of days 1, 2, 3, 4
  const r = computeTurnTimes([...snaps, ...added], startOf(12) + H);
  assert.equal(r.timedTurns, 12);
  assert.ok(r.players.every((p) => p.turns.every((t) => t.ms === 6 * H)));
  assert.deepEqual(r.missingDays, []);
});

test('backfill stops at its request budget', async () => {
  const { fetchTurn, requested } = fakeReplay(30);
  const snaps = [notify(30, 'a', '2026-12-01T00:00:00Z')];
  await backfillFromReplay(snaps, fetchTurn, { delayMs: 0, maxRequests: 5 });
  assert.equal(requested.length, 5);
});
