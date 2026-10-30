import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailySeries, inTimeOrder, metricValue, samplesToSeries, turnFraction, xDomain, type TurnSampleDoc } from './turn-series.ts';

// Game 1744366's real player ids and turn order. players_order is 3, 4, 9, 10, not 1..4, and
// id order (…363, …417, …554, …869) is not turn order — el_mero_mero sorts second, plays last.
const ORDER = {
  ridiculotron: ['4182363', 3],
  onetrickwolf: ['4182554', 4],
  alecnexus: ['4182869', 9],
  el_mero_mero: ['4182417', 10],
} as const;
type Name = keyof typeof ORDER;

function sample(day: number, turn: Name, values: Record<Name, number>, extra: Partial<Record<Name, object>> = {}): TurnSampleDoc {
  const players: Record<string, Record<string, unknown>> = {};
  for (const [name, [pid, order]] of Object.entries(ORDER) as Array<[Name, readonly [string, number]]>) {
    players[pid] = { username: name, order, unitValue: values[name], ...extra[name] };
  }
  return { day, turnPlayerId: ORDER[turn][0], players };
}

/** A full day, in the order Firestore returns it: by day, then doc id (player id), not by time. */
function dayInIdOrder(day: number, byTurn: Record<Name, Record<Name, number>>): TurnSampleDoc[] {
  return (Object.keys(ORDER) as Name[])
    .map((turn) => sample(day, turn, byTurn[turn]))
    .sort((a, b) => String(a.turnPlayerId).localeCompare(String(b.turnPlayerId)));
}

const v = (r: number, o: number, a: number, m: number) => ({ ridiculotron: r, onetrickwolf: o, alecnexus: a, el_mero_mero: m });

test('ranks a sparse players_order, so no sample lands in the next day', () => {
  assert.equal(turnFraction(sample(11, 'ridiculotron', v(1, 1, 1, 1))), 0);
  assert.equal(turnFraction(sample(11, 'onetrickwolf', v(1, 1, 1, 1))), 0.25);
  assert.equal(turnFraction(sample(11, 'alecnexus', v(1, 1, 1, 1))), 0.5);
  assert.equal(turnFraction(sample(11, 'el_mero_mero', v(1, 1, 1, 1))), 0.75);
  for (const s of samplesToSeries(dayInIdOrder(11, {
    ridiculotron: v(1, 1, 1, 1), onetrickwolf: v(1, 1, 1, 1), alecnexus: v(1, 1, 1, 1), el_mero_mero: v(1, 1, 1, 1),
  }), 'unitValue')) {
    for (const p of s.points) assert.ok(p.day + p.turn < 12, `${s.label} plotted at ${p.day + p.turn}`);
  }
});

test('places every player at the sample time, so a day never stacks into spikes', () => {
  const series = samplesToSeries(dayInIdOrder(5, {
    ridiculotron: v(10, 20, 30, 40), onetrickwolf: v(11, 21, 31, 41), alecnexus: v(12, 22, 32, 42), el_mero_mero: v(13, 23, 33, 43),
  }), 'unitValue');
  for (const s of series) {
    assert.deepEqual(s.points.map((p) => p.turn), [0, 0.25, 0.5, 0.75], `${s.label} has one point per turn`);
  }
});

test('the last point is the latest turn, even though docs arrive in player-id order', () => {
  // Day 12 of game 1744366: the chart labelled each line with the alecnexus-turn values
  // (ridiculotron 174k, alecnexus 105.9k) instead of the latest, el_mero_mero's turn.
  const docs = dayInIdOrder(12, {
    ridiculotron: v(164900, 174400, 112900, 158300),
    onetrickwolf: v(186000, 144400, 105900, 158300),
    alecnexus: v(174000, 173000, 105900, 151100),
    el_mero_mero: v(165000, 173000, 135900, 152500),
  });
  const last = Object.fromEntries(samplesToSeries(docs, 'unitValue').map((s) => [s.label, s.points.at(-1)!.value]));
  assert.deepEqual(last, { ridiculotron: 165000, onetrickwolf: 173000, alecnexus: 135900, el_mero_mero: 152500 });
});

test('inTimeOrder sorts by day, then by place in the day', () => {
  const sorted = inTimeOrder([
    { day: 2, turn: 0, value: 3 },
    { day: 1, turn: 0.5, value: 2 },
    { day: 1, turn: 0, value: 1 },
  ]);
  assert.deepEqual(sorted.map((p) => p.value), [1, 2, 3]);
});

test('elimination comes from the latest sample, not the last doc to arrive', () => {
  const docs = [
    sample(3, 'el_mero_mero', v(1, 1, 1, 1), { alecnexus: { eliminated: true } }),
    sample(3, 'ridiculotron', v(1, 1, 1, 1)), // earlier in the day, but arrives later
  ];
  const alec = samplesToSeries(docs, 'unitValue').find((s) => s.label === 'alecnexus')!;
  assert.equal(alec.eliminated, true);
});

test('series come out in turn order, so colours follow the player', () => {
  const series = samplesToSeries([sample(1, 'ridiculotron', v(4, 3, 2, 1))], 'unitValue');
  assert.deepEqual(series.map((s) => s.label), ['ridiculotron', 'onetrickwolf', 'alecnexus', 'el_mero_mero']);
});

test('a sample with no turn player sits at the start of its day', () => {
  const doc = sample(4, 'alecnexus', v(1, 1, 1, 1));
  delete doc.turnPlayerId;
  assert.equal(turnFraction(doc), 0);
});

test('skips players without the metric and docs without a day', () => {
  const doc = sample(2, 'ridiculotron', v(1, 1, 1, 1));
  delete (doc.players![ORDER.alecnexus[0]] as Record<string, unknown>).unitValue;
  const series = samplesToSeries([doc, { players: doc.players }], 'unitValue');
  assert.deepEqual(series.map((s) => s.label), ['ridiculotron', 'onetrickwolf', 'el_mero_mero']);
  assert.ok(series.every((s) => s.points.length === 1));
});

test('the x axis ends just past the latest sample, not a day later', () => {
  const { start, end } = xDomain([
    { day: 1, turn: 0, value: 0 },
    { day: 12, turn: 0.75, value: 0 },
  ]);
  assert.equal(start, 1);
  assert.ok(end > 12.75 && end < 13, `axis ends at ${end}`);
});

test('a lone day still gets a readable width', () => {
  const { start, end } = xDomain([{ day: 1, turn: 0, value: 0 }]);
  assert.equal(end - start, 0.5);
});

test('army value is units plus cash, so a build is not a sudden gain', () => {
  // alecnexus, day 12: he built a Neotank and an Anti-Air, 30k from funds into units.
  const before = metricValue({ unitValue: 105900, funds: 34300 }, 'armyValue');
  const after = metricValue({ unitValue: 135900, funds: 4300 }, 'armyValue');
  assert.equal(before, 140200);
  assert.equal(after, before);
});

test('army value is no point at all when funds are withheld', () => {
  assert.ok(!Number.isFinite(metricValue({ unitValue: 105900 }, 'armyValue')));
  const doc = sample(2, 'ridiculotron', v(1, 1, 1, 1), { ridiculotron: { funds: 500 } });
  const series = samplesToSeries([doc], 'armyValue');
  assert.deepEqual(series.map((s) => [s.label, s.points[0].value]), [['ridiculotron', 501]]);
});

test('stored metrics read straight through', () => {
  assert.equal(metricValue({ income: 22000 }, 'income'), 22000);
});

/** A sample in turn order where each player's army value is units + funds. */
function armySample(day: number, turn: Name, army: Record<Name, [number, number]>, extra: Partial<Record<Name, object>> = {}) {
  const units = Object.fromEntries(Object.entries(army).map(([n, [u]]) => [n, u])) as Record<Name, number>;
  const withFunds = Object.fromEntries(
    Object.entries(army).map(([n, [, f]]) => [n, { funds: f, ...extra[n as Name] }])
  ) as Partial<Record<Name, object>>;
  return sample(day, turn, units, withFunds);
}

test('daily points read each player after their own turn, not mid-day with unspent income', () => {
  // Game 1751089, day 6: el_mero_mero's turn-start sample credited his fresh 15.5k income as
  // army and put him above ridiculotron, who had 7.7k more on the board.
  const a = (r: [number, number], o: [number, number], al: [number, number], m: [number, number]) =>
    ({ ridiculotron: r, onetrickwolf: o, alecnexus: al, el_mero_mero: m });
  const docs = [
    armySample(6, 'ridiculotron', a([43700, 20600], [100, 0], [100, 0], [36000, 0])), // ridiculotron paid
    armySample(6, 'onetrickwolf', a([62500, 1600], [100, 0], [100, 0], [36000, 0])), // ridiculotron built
    armySample(6, 'alecnexus', a([62500, 1600], [100, 0], [100, 0], [36000, 0])),
    armySample(6, 'el_mero_mero', a([62500, 1600], [100, 0], [100, 0], [36000, 15500])), // mero paid
    armySample(7, 'ridiculotron', a([62500, 1600], [100, 0], [100, 0], [46800, 500])), // mero built
  ];
  const day6 = Object.fromEntries(dailySeries(docs, 'armyValue').map((s) => [s.label, s.points.map((p) => p.value)]));
  assert.deepEqual(day6, { ridiculotron: [64100], onetrickwolf: [100], alecnexus: [100], el_mero_mero: [47300] });
});

test('a day still being played is left off', () => {
  const all = v(1, 1, 1, 1);
  const docs = [
    sample(1, 'ridiculotron', all), sample(1, 'onetrickwolf', all), sample(1, 'alecnexus', all), sample(1, 'el_mero_mero', all),
    sample(2, 'ridiculotron', all), sample(2, 'onetrickwolf', all), sample(2, 'alecnexus', all), sample(2, 'el_mero_mero', all),
  ];
  // Day 2's last turn has begun but not ended, so only day 1 is finished.
  for (const s of dailySeries(docs, 'unitValue')) assert.deepEqual(s.points.map((p) => p.day), [1], s.label);
  assert.deepEqual(dailySeries(docs.slice(0, 3), 'unitValue'), [], 'no day has finished yet');
});

test('an eliminated player does not hold the day open', () => {
  const out = { el_mero_mero: { eliminated: true } };
  const docs = [
    sample(3, 'ridiculotron', v(1, 1, 1, 0), out),
    sample(3, 'onetrickwolf', v(1, 1, 1, 0), out),
    sample(3, 'alecnexus', v(2, 2, 2, 0), out),
    // No el_mero_mero turn: AWBW skips it. Day 3 ends when ridiculotron's day 4 begins.
    sample(4, 'ridiculotron', v(3, 3, 3, 0), out),
  ];
  const series = dailySeries(docs, 'unitValue');
  assert.deepEqual(series.map((s) => [s.label, s.points.map((p) => p.day)]), [
    ['ridiculotron', [3]], ['onetrickwolf', [3]], ['alecnexus', [3]], ['el_mero_mero', [3]],
  ]);
  assert.equal(series.find((s) => s.label === 'el_mero_mero')!.eliminated, true);
});

test('a missed stretch leaves a gap rather than borrowing a later turn', () => {
  const docs = [
    sample(1, 'ridiculotron', v(1, 1, 1, 1)),
    sample(1, 'onetrickwolf', v(1, 1, 1, 1)),
    sample(2, 'alecnexus', v(2, 2, 2, 2)), // bot was down from day 1 alecnexus to here
    sample(2, 'el_mero_mero', v(3, 3, 3, 3)),
    sample(3, 'ridiculotron', v(4, 4, 4, 4)),
  ];
  const byName = Object.fromEntries(dailySeries(docs, 'unitValue').map((s) => [s.label, s.points]));
  // alecnexus's day-1 turn ended before any sample until his day-2 turn began, which has day-2 income.
  assert.deepEqual(byName.alecnexus.map((p) => [p.day, p.value]), [[2, 3]]);
  // ridiculotron's turns were both seen, so each day reads the sample right after them.
  assert.deepEqual(byName.ridiculotron.map((p) => [p.day, p.value]), [[1, 1], [2, 2]]);
});
