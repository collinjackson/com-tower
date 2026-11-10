import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMetric, swing } from './featured.ts';
import { buildFeaturedGif } from './featured-chart.ts';
import type { Series } from './turn-series.ts';

const line = (key: string, values: number[], army = 'os'): Series => ({
  key,
  label: key,
  army,
  points: values.map((value, i) => ({ day: 1 + Math.floor(i / 2), turn: (i % 2) / 2, value })),
});

test('swing is the change in the leader-to-last spread, over the leader', () => {
  // Two players: one round is 2 points back, spread 0 (50 vs 50); now 40 (100 vs 60); leader 100.
  assert.equal(swing([line('a', [50, 60, 100]), line('b', [50, 50, 60])]), 0.4);
  assert.equal(swing([line('a', [1, 2]), line('b', [1, 2])]), 0, 'too few points');
});

test('pickMetric features the biggest swing and never repeats the last one', () => {
  const byMetric = {
    armyValue: [line('a', [50, 60, 100]), line('b', [50, 50, 60])], // 0.4
    unitCount: [line('a', [5, 5, 6]), line('b', [5, 5, 5])], // ~0.17
    properties: [line('a', [10, 10, 10]), line('b', [10, 10, 10])], // 0
  };
  assert.equal(pickMetric(byMetric), 'armyValue');
  assert.equal(pickMetric(byMetric, 'armyValue'), 'unitCount');
  assert.equal(pickMetric({ armyValue: [line('a', [1]), line('b', [1])] }), null, 'no history yet');
});

test('the featured chart is an animated GIF that holds its last frame', async () => {
  const gif = await buildFeaturedGif({
    series: [line('a', [10, 20, 30, 50], 'os'), line('b', [10, 15, 15, 20], 'bm')],
    title: 'Army value',
    isMoney: true,
    steps: 4,
    hold: 2,
    width: 320,
    height: 180,
  });
  assert.equal(gif.frames, 6);
  assert.equal(gif.data.subarray(0, 6).toString('latin1'), 'GIF89a');
});
