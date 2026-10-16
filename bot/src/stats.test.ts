import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTurnStats, recordTurnStats, type TurnStats } from './stats.ts';

/** The bits of an AWBW game page the parser reads, in the shape the page emits them. */
function gamePage(day: number | undefined, players: object, units: object): string {
  return [
    day === undefined ? '' : `let gameDay = ${day};`,
    `let playersInfo = ${JSON.stringify(players)};`,
    `let unitsInfo = ${JSON.stringify(units)};`,
    '',
  ].join('\n');
}

const PLAYERS = {
  4182363: { users_username: 'ridiculotron', countries_code: 'sc', players_team: 'A', players_order: 3, players_eliminated: 'N', players_funds: 3100, players_income: 36000, co_name: 'Max' },
  4182869: { users_username: 'alecnexus', countries_code: 'ab', players_team: 'B', players_order: 9, players_eliminated: 'Y', players_funds: 0, co_name: 'Andy' },
};
const UNITS = {
  1: { units_players_id: 4182363, units_cost: 22000, units_hit_points: 10 }, // Neotank, full
  2: { units_players_id: 4182363, units_cost: 7000, units_hit_points: 5 }, // Tank at half HP
  3: { units_players_id: 4182869, units_cost: 1000, units_hit_points: 3 },
};

test('reads HP-weighted unit value and standing for every player', () => {
  const stats = parseTurnStats(gamePage(12, PLAYERS, UNITS), '4182363')!;
  assert.equal(stats.day, 12);
  assert.equal(stats.turnPlayerId, '4182363');
  const r = stats.players['4182363'];
  assert.equal(r.username, 'ridiculotron');
  assert.equal(r.unitValue, 25500); // 22000 + 7000 * 5/10
  assert.equal(r.unitCount, 2);
  assert.equal(r.order, 3);
  assert.equal(r.funds, 3100);
  assert.equal(r.eliminated, false);
  const a = stats.players['4182869'];
  assert.equal(a.unitValue, 300);
  assert.equal(a.eliminated, true);
});

test('a player with no units on the board is worth zero, not missing', () => {
  const stats = parseTurnStats(gamePage(1, PLAYERS, {}), '4182363')!;
  assert.equal(stats.players['4182363'].unitValue, 0);
  assert.equal(stats.players['4182363'].unitCount, 0);
});

test('no sample when the page has no day to file it under', () => {
  assert.equal(parseTurnStats(gamePage(undefined, PLAYERS, UNITS)), undefined);
});

/** Just enough Firestore for recordTurnStats: create() fails with ALREADY_EXISTS like the real
 *  one, and set() overwrites — so a regression back to set() shows up as a replaced sample. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    collection: (c: string) => ({
      doc: (game: string) => ({
        collection: (sub: string) => ({
          doc: (key: string) => ({
            create: async (data: Record<string, unknown>) => {
              const path = `${c}/${game}/${sub}/${key}`;
              if (docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
              docs.set(path, data);
            },
            set: async (data: Record<string, unknown>) => {
              docs.set(`${c}/${game}/${sub}/${key}`, data);
            },
          }),
        }),
      }),
    }),
  };
  return { db: db as unknown as Parameters<typeof recordTurnStats>[2], docs };
}

const atTurnStart: TurnStats = { day: 11, turnPlayerId: '4182417', players: { 4182417: { username: 'el_mero_mero', unitValue: 129700, unitCount: 20, eliminated: false } } };
const midTurn: TurnStats = { day: 11, turnPlayerId: '4182417', players: { 4182417: { username: 'el_mero_mero', unitValue: 158300, unitCount: 22, eliminated: false } } };

test('files each sample under its day and turn player', async () => {
  const { db, docs } = fakeDb();
  await recordTurnStats('1744366', atTurnStart, db);
  assert.deepEqual([...docs.keys()], ['games/1744366/turnStats/d0011-p4182417']);
});

test('a later re-bind or /sync cannot overwrite the turn-start sample', async () => {
  // Game 1744366, day 11: a /game re-bind partway through el_mero_mero's turn replaced his
  // 129.7k turn-start sample with the 158.3k standing from mid-turn.
  const { db, docs } = fakeDb();
  await recordTurnStats('1744366', atTurnStart, db);
  await recordTurnStats('1744366', midTurn, db); // must not throw, must not replace
  const kept = docs.get('games/1744366/turnStats/d0011-p4182417') as unknown as TurnStats;
  assert.equal(kept.players['4182417'].unitValue, 129700);
});

test('a sample with no turn player still gets a stable key', async () => {
  const { db, docs } = fakeDb();
  await recordTurnStats('1', { day: 3, players: {} }, db);
  assert.deepEqual([...docs.keys()], ['games/1/turnStats/d0003-px']);
});

test('a storage failure is logged, never thrown into the turn ping', async () => {
  const db = {
    collection: () => { throw new Error('firestore down'); },
  } as unknown as Parameters<typeof recordTurnStats>[2];
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    await recordTurnStats('1', atTurnStart, db);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
});
