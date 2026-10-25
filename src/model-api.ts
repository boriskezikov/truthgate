// The Messages API path of the model seam (`ApiModelClientFactory` in model.ts): one `POST /v1/messages` per
// structured call, with the JSON schema as `output_config.format` (structured outputs; no beta header as of
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs, read 2026-10-25). The answer is the first
// text block, parsed as JSON. 429, 5xx and network errors are retried with exponential backoff, honouring
// `retry-after`; a timeout, a 4xx or a malformed answer fails at once. No SDK: the repository allows node:* only, and
// the call is one request. Every error message is scrubbed of the API key before it leaves this module.
import { PRICES_PER_MTOK } from './model.ts';
import type { ApiClientOptions, ModelClient, StructuredCall, StructuredResult } from './model.ts';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1_000;
const RETRY_AFTER_CAP_MS = 60_000;
const EXCERPT = 300;

export type ModelApiErrorKind = 'http' | 'network' | 'timeout' | 'response' | 'budget';

/** A failed API call: `kind` says where it failed, `status` is the HTTP status for kind 'http', `attempts` how many requests were made. */
export class ModelApiError extends Error {
  constructor(readonly kind: ModelApiErrorKind, message: string, readonly status: number | undefined, readonly attempts: number) {
    super(message);
    this.name = 'ModelApiError';
  }
}

type SchemaNode = Record<string, unknown>;

/** Structured outputs require `additionalProperties: false` on every object; the schemas in extract.ts and verify.ts omit it. */
export function strictSchema(schema: object): object {
  const s: SchemaNode = { ...(schema as SchemaNode) };
  if (s.type === 'object' && s.additionalProperties === undefined) s.additionalProperties = false;
  for (const key of ['properties', '$defs', 'definitions']) {
    const map = s[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) s[key] = Object.fromEntries(Object.entries(map as Record<string, object>).map(([k, v]) => [k, strictSchema(v)]));
  }
  if (s.items && typeof s.items === 'object') s.items = Array.isArray(s.items) ? s.items.map((x) => strictSchema(x as object)) : strictSchema(s.items as object);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[key])) s[key] = (s[key] as object[]).map(strictSchema);
  return s;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** `retry-after` as milliseconds: a number of seconds or an HTTP date; null when absent or unreadable. Capped. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header == null || header.trim() === '') return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, ms));
}

function backoffMs(attempt: number): number { return BACKOFF_BASE_MS * 2 ** (attempt - 1); }

/** The API's error body is `{ type: 'error', error: { type, message } }`; anything else is shown as text. */
function errorExcerpt(text: string): string {
  try {
    const e = JSON.parse(text) as { error?: { type?: string; message?: string } };
    if (e.error && typeof e.error.message === 'string') return `${e.error.type ?? 'error'}: ${e.error.message.slice(0, EXCERPT)}`;
  } catch { /* not JSON: shown as text below */ }
  return text.slice(0, EXCERPT);
}

function describeNetworkError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return `${err.message ?? String(e)}${cause ? ` (${cause})` : ''}`;
}

interface ApiMessage {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  stop_details?: { category?: string | null };
}

export function apiModelClient(o: ApiClientOptions): ModelClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = `${(o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
  const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
  const price = PRICES_PER_MTOK[o.model];
  if (!price) process.stderr.write(`truthgate: no price known for ${o.model} (model.ts PRICES_PER_MTOK); judgeCostUsd will be 0 on the api path\n`);
  const redact = (s: string) => (o.apiKey ? s.split(o.apiKey).join('[api key]') : s);
  const fail = (kind: ModelApiErrorKind, message: string, status: number | undefined, attempts: number) => new ModelApiError(kind, redact(message), status, attempts);

  const parse = <T>(text: string, attempts: number): Omit<StructuredResult<T>, 'attempts'> => {
    let msg: ApiMessage;
    try { msg = JSON.parse(text) as ApiMessage; } catch { throw fail('response', `the Messages API answered 200 with a body that is not JSON: ${text.slice(0, EXCERPT)}`, 200, attempts); }
    if (msg.stop_reason === 'refusal') throw fail('response', `the model refused the call (category ${msg.stop_details?.category ?? 'not given'})`, 200, attempts);
    if (msg.stop_reason === 'max_tokens') throw fail('response', `the answer was cut at max_tokens (${MAX_TOKENS}); the JSON is incomplete`, 200, attempts);
    const block = msg.content?.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!block) throw fail('response', `the answer has no text block (stop_reason ${msg.stop_reason ?? 'not given'})`, 200, attempts);
    let output: T;
    try { output = JSON.parse(block.text!) as T; } catch { throw fail('response', `the text block is not JSON: ${block.text!.slice(0, EXCERPT)}`, 200, attempts); }
    const inputTokens = msg.usage?.input_tokens ?? 0;
    const outputTokens = msg.usage?.output_tokens ?? 0;
    const costUsd = price ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : 0;
    return { output, costUsd, inputTokens, outputTokens };
  };

  return {
    model: o.model,
    path: 'api',
    async structured<T>(call: StructuredCall): Promise<StructuredResult<T>> {
      const body = JSON.stringify({
        model: o.model, max_tokens: MAX_TOKENS, system: call.system,
        messages: [{ role: 'user', content: call.prompt }],
        output_config: { format: { type: 'json_schema', schema: strictSchema(call.schema) } },
      });
      const timeoutMs = call.timeoutMs ?? o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // The caller's budget is a ceiling, estimated before the call: about four bytes per input token, and the
      // output cap as the worst case; a prompt that cannot fit the budget is refused, not billed.
      if (call.maxBudgetUsd !== undefined && price) {
        const estimate = ((body.length / 4) * price.input + MAX_TOKENS * price.output) / 1_000_000;
        if (estimate > call.maxBudgetUsd) throw fail('budget', `the call could cost about $${estimate.toFixed(2)} (${Math.round(body.length / 4)} input tokens, up to ${MAX_TOKENS} output) against a budget of $${call.maxBudgetUsd}`, undefined, 0);
      }
      for (let attempt = 1; ; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let status: number;
        let text: string;
        let retryAfter: string | null = null;
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'x-api-key': o.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
            body,
            signal: ctl.signal,
            // The key goes to the configured endpoint only: a redirect is never followed.
            redirect: 'manual',
          });
          status = res.status;
          retryAfter = res.headers.get('retry-after');
          text = await res.text();
          if (status >= 300 && status < 400) text = res.headers.get('location') ?? '';
        } catch (e) {
          if (ctl.signal.aborted) throw fail('timeout', `the Messages API did not answer within ${timeoutMs} ms`, undefined, attempt);
          const err = fail('network', `the Messages API could not be reached: ${describeNetworkError(e)}`, undefined, attempt);
          if (attempt > maxRetries) throw err;
          await sleep(backoffMs(attempt));
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (status >= 300 && status < 400) throw fail('http', `the Messages API answered ${status} with a redirect to ${text || 'an undisclosed location'}; redirects are not followed`, status, attempt);
        if (status === 429 || status >= 500) {
          const err = fail('http', `the Messages API answered ${status}: ${errorExcerpt(text)}`, status, attempt);
          if (attempt > maxRetries) throw err;
          await sleep(retryAfterMs(retryAfter) ?? backoffMs(attempt));
          continue;
        }
        if (status < 200 || status >= 300) throw fail('http', `the Messages API answered ${status}: ${errorExcerpt(text)}`, status, attempt);
        return { ...parse<T>(text, attempt), attempts: attempt };
      }
    },
  };
}

/** A deterministic client for self-checks: no claims from the extractor, no verdicts from the judge, no cost. The
 *  schema's property names say which call it is. */
export function fakeModelClient(model: string): ModelClient {
  return {
    model,
    path: 'fake',
    async structured<T>(call: StructuredCall): Promise<StructuredResult<T>> {
      const props = Object.keys((call.schema as { properties?: Record<string, unknown> }).properties ?? {});
      if (props.includes('claims')) return { output: { claims: [] } as T, costUsd: 0, attempts: 1 };
      if (props.includes('verdicts')) return { output: { verdicts: [], failures: [] } as T, costUsd: 0, attempts: 1 };
      throw new Error(`fake model client: no canned answer for a schema with properties ${props.join(', ') || '(none)'}`);
    },
  };
}

