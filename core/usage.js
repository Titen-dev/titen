// Collects token usage and cost across all LLM calls of one command/request.
export class Usage {
  constructor() {
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cost = 0;
    this.webSearches = 0;
  }

  add(u) {
    this.calls += 1;
    if (!u) return;
    this.promptTokens += u.prompt_tokens || 0;
    this.completionTokens += u.completion_tokens || 0;
    this.cost += Number(u.cost) || 0;
  }

  toJSON() {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cost: Math.round(this.cost * 1e6) / 1e6,
      webSearches: this.webSearches,
    };
  }
}
