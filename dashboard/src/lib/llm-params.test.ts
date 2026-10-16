import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionParams, isReasoningModel } from './llm-params.ts';

test('reasoning models get effort and room to think, never temperature', () => {
  for (const m of ['gpt-5.5', 'gpt-5.4-mini', 'o3', 'o4-mini']) {
    assert.ok(isReasoningModel(m), m);
    assert.deepEqual(completionParams(m, { temperature: 0.2, maxTokens: 400 }), {
      reasoning_effort: 'low',
      max_completion_tokens: 4400,
    });
  }
});

test('chat models keep temperature and their reply cap', () => {
  for (const m of ['gpt-4o-mini', 'gpt-4.1', 'gpt-5-chat-latest']) {
    assert.ok(!isReasoningModel(m), m);
    assert.deepEqual(completionParams(m, { temperature: 0.2, maxTokens: 400 }), { temperature: 0.2, max_tokens: 400 });
  }
});
