// Chat-completion settings that differ by OpenAI model family. Reasoning models (gpt-5.x, o-series)
// reject `temperature` and `max_tokens`, and spend part of their token budget thinking, so a cap
// sized for the visible reply alone leaves them nothing to answer with.

/** The fun-mode judge. A stronger model than the writer: it ranks candidates and labels their
 *  topics, and the topic filter is only as good as those labels. */
export const DEFAULT_JUDGE_MODEL = 'gpt-5.5';

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model) && !/chat-latest/.test(model);
}

/** `temperature` and the reply cap for a non-reasoning model; low effort and room to think otherwise. */
export function completionParams(
  model: string,
  opts: { temperature: number; maxTokens: number }
): { temperature: number; max_tokens: number } | { reasoning_effort: 'low'; max_completion_tokens: number } {
  return isReasoningModel(model)
    ? { reasoning_effort: 'low', max_completion_tokens: opts.maxTokens + 4000 }
    : { temperature: opts.temperature, max_tokens: opts.maxTokens };
}
