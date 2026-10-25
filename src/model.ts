// The one seam to a model: a structured call (system + prompt + JSON schema → object). Two clients implement it:
// the Claude Code CLI on the host's login (research use), and the Messages API with an API key (the service path).
import { runJudge } from './cli-engine.ts';

export interface StructuredCall { system: string; prompt: string; schema: object; maxBudgetUsd?: number; timeoutMs?: number }
export interface StructuredResult<T> { output: T; costUsd: number; attempts: number; inputTokens?: number; outputTokens?: number }

export interface ModelClient {
  readonly model: string;
  readonly path: 'cli' | 'api' | 'fake' | 'openai';
  structured<T>(call: StructuredCall): Promise<StructuredResult<T>>;
}

/** The claude CLI in headless mode (`claude -p --json-schema`), on whatever account is logged in on this host. */
export function cliModelClient(model: string): ModelClient {
  return {
    model,
    path: 'cli',
    async structured<T>(call: StructuredCall): Promise<StructuredResult<T>> {
      const r = await runJudge<T>({ model, system: call.system, prompt: call.prompt, schema: call.schema, maxBudgetUsd: call.maxBudgetUsd, timeoutMs: call.timeoutMs });
      return { output: r.output, costUsd: r.costUsd, attempts: r.attempts };
    },
  };
}

/** Prices per million tokens for the cost estimate of the API path (2026-10, first-party rates). */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface ApiClientOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Injected for a self-check against a fake server; global fetch otherwise. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Implemented in model-api.ts: one Messages API call with `output_config.format` = the JSON schema. */
export type ApiModelClientFactory = (o: ApiClientOptions) => ModelClient;
