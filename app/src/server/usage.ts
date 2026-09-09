export function codexDelta(
  total: { inputTokens: number; outputTokens: number },
  previous = { inputTokens: 0, outputTokens: 0 },
) {
  return {
    input: Math.max(0, total.inputTokens - previous.inputTokens),
    output: Math.max(0, total.outputTokens - previous.outputTokens),
  };
}
// Anthropic reports uncached input and cache input in disjoint fields.
// Codex already includes cached input and reasoning output in its totals.
export function claudeUsage(result: any, fallbackModel: string) {
  const models = Object.entries(result.modelUsage ?? {});
  if (!models.length) {
    const u = result.usage;
    return [
      {
        model: fallbackModel,
        input: u
          ? u.input_tokens +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          : null,
        output: u?.output_tokens ?? null,
        raw: u,
      },
    ];
  }
  return models.map(([model, u]: [string, any]) => ({
    model,
    input:
      u.inputTokens +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheCreationInputTokens ?? 0),
    output: u.outputTokens ?? null,
    raw: u,
  }));
}
