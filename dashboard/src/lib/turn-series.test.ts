import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inTimeOrder, samplesToSeries, turnFraction, xDomain, type TurnSampleDoc } from './turn-series.ts';

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
