import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageOf, parseLanguage } from './language.ts';

test('/language off, english or nothing means English', () => {
  for (const a of ['', 'off', 'English', ' en ', 'default']) assert.equal(parseLanguage(a), undefined);
  assert.equal(parseLanguage(' Pirate '), 'Pirate');
  assert.equal(parseLanguage('x'.repeat(60))?.length, 40);
});

test('the player to move picks the language, matched case-insensitively', () => {
  const players = { Alice: { language: 'Spanish' }, bob: {} };
  assert.equal(languageOf(players, 'alice'), 'Spanish');
  assert.equal(languageOf(players, 'Bob'), undefined);
  assert.equal(languageOf(players, 'carol'), undefined);
  assert.equal(languageOf(undefined, 'alice'), undefined);
});
