// The OpenAI-compatible path of the model seam (`ModelClient` in model.ts): one `POST /chat/completions` per
// structured call with the JSON schema as `response_format: { type: 'json_schema', json_schema: { strict, schema } }`,
// the shape OpenRouter, NVIDIA's endpoint, Ollama's `/v1` and most hosted open models accept
// (https://openrouter.ai/docs/features/structured-outputs, read 2026-10-25). The answer is `choices[0].message.content`,
// parsed as JSON. Retries, timeouts, the redirect refusal and the key scrubbing follow model-api.ts; the helpers come
// from there. The cost is `usage.cost` when the endpoint reports it (OpenRouter does, in USD), else from `pricePerMTok` when given, else 0.
import { ModelApiError, retryAfterMs, strictSchema } from './model-api.ts';
import type { ModelApiErrorKind } from './model-api.ts';
import type { ModelClient, StructuredCall, StructuredResult } from './model.ts';

const MAX_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1_000;
const EXCERPT = 300;

export interface OpenAiClientOptions {
  model: string;
  /** `${baseUrl}/chat/completions` is called; OpenRouter: https://openrouter.ai/api/v1, Ollama: http://127.0.0.1:11434/v1. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer`; absent for a local server that needs none. */
  apiKey?: string;
  /** Extra headers the endpoint wants (OpenRouter: HTTP-Referer, X-Title). */
  headers?: Record<string, string>;
  pricePerMTok?: { input: number; output: number };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** The output cap sent as `max_tokens`; MAX_TOKENS when absent (a free model may allow less: see `max_completion_tokens` in the catalogue). */
  maxTokens?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  /** OpenRouter adds `cost` in USD (0 on a free model); other endpoints omit it. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function backoffMs(attempt: number): number { return BACKOFF_BASE_MS * 2 ** (attempt - 1); }

/** OpenAI-style errors are `{ error: { message, code } }`; OpenRouter also answers 200 with an `error` body. */
function errorExcerpt(text: string): string {
  try {
    const e = JSON.parse(text) as ChatCompletion;
    if (e.error && typeof e.error.message === 'string') return `${e.error.code ?? 'error'}: ${e.error.message.slice(0, EXCERPT)}`;
  } catch { /* not JSON: shown as text below */ }
  return text.slice(0, EXCERPT);
}

/** The JSON object inside a content that a model wrapped in a code fence or prose, when it is not bare JSON. */
function parseJsonContent<T>(content: string): T {
  try { return JSON.parse(content) as T; } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1];
  if (fenced) { try { return JSON.parse(fenced) as T; } catch { /* fall through */ } }
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1)) as T;
  throw new SyntaxError('no JSON object in the content');
}

export function openaiModelClient(o: OpenAiClientOptions): ModelClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
  const redact = (s: string) => (o.apiKey ? s.split(o.apiKey).join('[api key]') : s);
  const fail = (kind: ModelApiErrorKind, message: string, status: number | undefined, attempts: number) => new ModelApiError(kind, redact(message), status, attempts);

  const parse = <T>(text: string, attempts: number): Omit<StructuredResult<T>, 'attempts'> => {
    let msg: ChatCompletion;
    try { msg = JSON.parse(text) as ChatCompletion; } catch { throw fail('response', `the endpoint answered 200 with a body that is not JSON: ${text.slice(0, EXCERPT)}`, 200, attempts); }
    if (msg.error) throw fail('response', `the endpoint answered 200 with an error: ${errorExcerpt(text)}`, 200, attempts);
    const choice = msg.choices?.[0];
    if (!choice?.message) throw fail('response', `the answer has no choices[0].message: ${text.slice(0, EXCERPT)}`, 200, attempts);
    if (choice.message.refusal) throw fail('response', `the model refused the call: ${choice.message.refusal.slice(0, EXCERPT)}`, 200, attempts);
    if (choice.finish_reason === 'length') throw fail('response', `the answer was cut at max_tokens (${o.maxTokens ?? MAX_TOKENS}); the JSON is incomplete`, 200, attempts);
    const content = choice.message.content;
    if (typeof content !== 'string' || !content.trim()) throw fail('response', `the answer has no content (finish_reason ${choice.finish_reason ?? 'not given'})`, 200, attempts);
    let output: T;
    try { output = parseJsonContent<T>(content); } catch { throw fail('response', `the content is not JSON: ${content.slice(0, EXCERPT)}`, 200, attempts); }
    const inputTokens = msg.usage?.prompt_tokens ?? 0;
    const outputTokens = msg.usage?.completion_tokens ?? 0;
    const reported = msg.usage?.cost;
    const costUsd = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : o.pricePerMTok ? (inputTokens * o.pricePerMTok.input + outputTokens * o.pricePerMTok.output) / 1e6 : 0;
    return { output, costUsd, inputTokens, outputTokens };
  };

  return {
    model: o.model,
    path: 'openai',
    async structured<T>(call: StructuredCall): Promise<StructuredResult<T>> {
      const body = JSON.stringify({
        model: o.model, max_tokens: o.maxTokens ?? MAX_TOKENS, temperature: 0,
        messages: [{ role: 'system', content: call.system }, { role: 'user', content: call.prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: strictSchema(call.schema) } },
      });
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers ?? {}) };
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
      const timeoutMs = call.timeoutMs ?? o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      for (let attempt = 1; ; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let status: number;
        let text: string;
        let retryAfter: string | null = null;
        try {
          // redirect: 'manual', as in model-api.ts: the key goes to this origin only.
          const res = await fetchImpl(url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'manual' });
          status = res.status;
          retryAfter = res.headers.get('retry-after');
          text = await res.text();
        } catch (e) {
          if (ctl.signal.aborted) throw fail('timeout', `the endpoint did not answer within ${timeoutMs} ms`, undefined, attempt);
          const err = e as { message?: string; cause?: { code?: string; message?: string } };
          const cause = err.cause?.code ?? err.cause?.message;
          const failure = fail('network', `the endpoint could not be reached: ${err.message ?? String(e)}${cause ? ` (${cause})` : ''}`, undefined, attempt);
          if (attempt > maxRetries) throw failure;
          await sleep(backoffMs(attempt));
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (status >= 300 && status < 400) throw fail('http', `the endpoint answered ${status} (a redirect); the key is sent to the configured origin only`, status, attempt);
        if (status === 429 || status >= 500) {
          const err = fail('http', `the endpoint answered ${status}: ${errorExcerpt(text)}`, status, attempt);
          if (attempt > maxRetries) throw err;
          await sleep(retryAfterMs(retryAfter) ?? backoffMs(attempt));
          continue;
        }
        if (status < 200 || status >= 300) throw fail('http', `the endpoint answered ${status}: ${errorExcerpt(text)}`, status, attempt);
        return { ...parse<T>(text, attempt), attempts: attempt };
      }
    },
  };
}

/** The OpenAI-compatible client from the environment: OPENAI_BASE_URL (required), OPENAI_API_KEY (optional),
 *  OPENAI_MAX_TOKENS (optional); OpenRouter's attribution headers are sent when OPENROUTER_REFERER / OPENROUTER_TITLE
 *  are set. */
export function openaiClientFromEnv(model: string, env: NodeJS.ProcessEnv = process.env): ModelClient {
  const baseUrl = env.OPENAI_BASE_URL;
  if (!baseUrl) throw new Error('TRUTHGATE_MODEL_PATH=openai needs OPENAI_BASE_URL (OpenRouter: https://openrouter.ai/api/v1)');
  const headers: Record<string, string> = {};
  if (env.OPENROUTER_REFERER) headers['HTTP-Referer'] = env.OPENROUTER_REFERER;
  if (env.OPENROUTER_TITLE) headers['X-Title'] = env.OPENROUTER_TITLE;
  const maxTokens = env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : undefined;
  if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens > 0)) throw new Error('OPENAI_MAX_TOKENS must be a positive integer');
  return openaiModelClient({ model, baseUrl, apiKey: env.OPENAI_API_KEY || env.OPENROUTER_API_KEY, headers, maxTokens });
}
