// Self-check of the Messages API client and the OpenAI-compatible client against a fake API on loopback: the request shape (headers, body,
// `output_config.format`), the retry on 429 and 5xx honouring `retry-after`, the retry on a network error, no retry
// on a 4xx, the timeout, the cost arithmetic, and that the key never appears in an error. No real API is reached.
// Prints one line per check and exits non-zero on any failure.
// Usage: npx tsx bench/selfcheck-api.ts
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiModelClient, ModelApiError, retryAfterMs, strictSchema } from '../src/model-api.ts';
import { modelClientFromEnv } from '../src/model-env.ts';
import { openaiClientFromEnv, openaiModelClient } from '../src/model-openai.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
}

const KEY = 'sk-ant-selfcheck-key';
const MODEL = 'claude-sonnet-5-5';
/** The shape of the extractor's schema: an object holding an array of objects, with no additionalProperties set. */
const SCHEMA = { type: 'object', properties: { claims: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }, required: ['claims'] };
const CALL = { system: 'You extract claims.', prompt: 'TASK: x\nREPORT: y', schema: SCHEMA };

type Step = (res: ServerResponse) => void;
interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }
const seen: Seen[] = [];
const script: Step[] = [];
const held: ServerResponse[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c.toString(); });
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
    const step = script.shift();
    if (!step) { res.writeHead(500); res.end('no scripted step'); return; }
    step(res);
  });
});
const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => { resolve((server.address() as { port: number }).port); }));
const baseUrl = `http://127.0.0.1:${port}/`; // trailing slash: the client must not produce //v1/messages

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Step => (res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const message = (output: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(output) }],
  stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 }, ...extra,
});
const apiError = (type: string, msg: string) => ({ type: 'error', error: { type, message: msg } });
const client = apiModelClient({ model: MODEL, apiKey: KEY, baseUrl });
const failure = async (fn: () => Promise<unknown>): Promise<ModelApiError | null> => { try { await fn(); return null; } catch (e) { return e instanceof ModelApiError ? e : null; } };

// ---------- 429 then 200: the request shape and the retry ----------
{
  seen.length = 0;
  script.push(json(429, apiError('rate_limit_error', 'slow down'), { 'retry-after': '0' }), json(200, message({ claims: [{ text: 'a' }] })));
  const r = await client.structured<{ claims: unknown[] }>(CALL);
  check('429 then 200: two requests, attempts 2', seen.length === 2 && r.attempts === 2, `${seen.length} requests, attempts ${r.attempts}`);
  check('the output is the parsed first text block (after a thinking block)', JSON.stringify(r.output) === JSON.stringify({ claims: [{ text: 'a' }] }), JSON.stringify(r.output));
  check('cost = 1000 input × $2/MTok + 50 output × $10/MTok', Math.abs(r.costUsd - 0.0025) < 1e-12 && r.inputTokens === 1000 && r.outputTokens === 50, `${r.costUsd} ${r.inputTokens} ${r.outputTokens}`);
  const q = seen[0]!;
  check('POST /v1/messages', q.method === 'POST' && q.url === '/v1/messages', `${q.method} ${q.url}`);
  check('headers x-api-key, anthropic-version 2023-06-01, content-type application/json', q.headers['x-api-key'] === KEY && q.headers['anthropic-version'] === '2023-06-01' && q.headers['content-type'] === 'application/json', JSON.stringify(q.headers));
  const b = q.body as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }>; output_config: { format: { type: string; schema: Record<string, unknown> } } };
  check('body: model, max_tokens 32000, system, one user message with the prompt', b.model === MODEL && b.max_tokens === 32000 && b.system === CALL.system && b.messages.length === 1 && b.messages[0]!.role === 'user' && b.messages[0]!.content === CALL.prompt, JSON.stringify(b).slice(0, 300));
  check('body: output_config.format is { type: json_schema, schema }', b.output_config?.format?.type === 'json_schema' && typeof b.output_config.format.schema === 'object', JSON.stringify(b.output_config));
  const sch = b.output_config.format.schema as { additionalProperties?: boolean; properties: { claims: { items: { additionalProperties?: boolean } } } };
  check('the schema carries additionalProperties: false on every object', sch.additionalProperties === false && sch.properties.claims.items.additionalProperties === false, JSON.stringify(sch));
  check('the caller\'s schema is not mutated', !('additionalProperties' in SCHEMA) && JSON.stringify(strictSchema(SCHEMA)) !== JSON.stringify(SCHEMA));
  check('no body key beyond model, max_tokens, system, messages, output_config', Object.keys(b).sort().join(',') === 'max_tokens,messages,model,output_config,system', Object.keys(b).join(','));
}

// ---------- the budget is a ceiling: a prompt that cannot fit it is refused before any request ----------
{
  seen.length = 0;
  const e = await failure(() => client.structured({ ...CALL, prompt: 'x'.repeat(2_000_000), maxBudgetUsd: 0.5 }));
  check('a call over its budget is refused without a request, kind budget', seen.length === 0 && e?.kind === 'budget' && /budget of \$0\.5/.test(e.message), `${seen.length} requests; ${e?.kind} ${e?.message}`);
}

// ---------- a redirect is never followed: the key goes to the configured endpoint only ----------
{
  seen.length = 0;
  script.push((res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }); res.end(); });
  const e = await failure(() => client.structured(CALL));
  check('a 3xx is not followed: one request, kind http, the location named', seen.length === 1 && e?.kind === 'http' && e.status === 302 && e.message.includes('redirect') && e.message.includes('127.0.0.1:1/steal'), `${seen.length} requests; ${e?.kind} ${e?.status} ${e?.message}`);
}

// ---------- 5xx three times: retried twice, then a typed error without the key ----------
{
  seen.length = 0;
  const body = apiError('overloaded_error', `overloaded; your key ${KEY} is fine`);
  script.push(json(503, body, { 'retry-after': '0' }), json(529, body, { 'retry-after': '0' }), json(500, body, { 'retry-after': '0' }));
  const e = await failure(() => client.structured(CALL));
  check('5xx is retried twice and then fails with kind http', seen.length === 3 && e?.kind === 'http' && e.status === 500 && e.attempts === 3, `${seen.length} requests; ${e?.kind} ${e?.status} ${e?.attempts}`);
  check('the error names the status and the API message', !!e && e.message.includes('500') && e.message.includes('overloaded_error'), e?.message);
  check('the error never carries the API key', !!e && !e.message.includes(KEY) && e.message.includes('[api key]'), e?.message);
}

// ---------- 4xx: no retry ----------
{
  seen.length = 0;
  script.push(json(400, apiError('invalid_request_error', 'bad schema')));
  const e = await failure(() => client.structured(CALL));
  check('400 is not retried', seen.length === 1 && e?.kind === 'http' && e.status === 400 && e.attempts === 1, `${seen.length} requests; ${e?.kind} ${e?.status} ${e?.attempts}`);
  check('the 400 message carries the API error', !!e && e.message.includes('invalid_request_error: bad schema'), e?.message);
}

// ---------- a network error once, then 200 ----------
{
  seen.length = 0;
  let thrown = false;
  const flaky = apiModelClient({ model: MODEL, apiKey: KEY, baseUrl, fetchImpl: (url, init) => { if (!thrown) { thrown = true; return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })); } return fetch(url, init); } });
  script.push(json(200, message({ claims: [] })));
  const t0 = Date.now();
  const r = await flaky.structured<{ claims: unknown[] }>(CALL);
  check('a network error is retried after a backoff of about 1 s', seen.length === 1 && r.attempts === 2 && Date.now() - t0 >= 900, `${seen.length} requests, attempts ${r.attempts}, ${Date.now() - t0} ms`);
  const dead = apiModelClient({ model: MODEL, apiKey: KEY, baseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
  const e = await failure(() => dead.structured(CALL));
  check('a dead endpoint fails with kind network and the cause', e?.kind === 'network' && e.attempts === 1 && /ECONNREFUSED|fetch failed/.test(e.message), `${e?.kind} ${e?.message}`);
}

// ---------- timeout: the response never comes ----------
{
  seen.length = 0;
  script.push((res) => { held.push(res); });
  const slow = apiModelClient({ model: MODEL, apiKey: KEY, baseUrl, timeoutMs: 200 });
  const t0 = Date.now();
  const e = await failure(() => slow.structured(CALL));
  check('a call past timeoutMs fails with kind timeout and is not retried', e?.kind === 'timeout' && e.attempts === 1 && Date.now() - t0 < 2_000, `${e?.kind} ${e?.attempts} ${Date.now() - t0} ms`);
  const perCall = apiModelClient({ model: MODEL, apiKey: KEY, baseUrl });
  script.push((res) => { held.push(res); });
  const e2 = await failure(() => perCall.structured({ ...CALL, timeoutMs: 100 }));
  check('StructuredCall.timeoutMs overrides the client timeout', e2?.kind === 'timeout' && e2.message.includes('100 ms'), e2?.message);
}

// ---------- malformed answers ----------
{
  script.push(json(200, { ...message({}), content: [{ type: 'text', text: 'not json {' }] }));
  const e = await failure(() => client.structured(CALL));
  check('a text block that is not JSON fails with kind response', e?.kind === 'response' && e.message.includes('not JSON'), `${e?.kind} ${e?.message}`);
  script.push(json(200, message({ claims: [] }, { stop_reason: 'max_tokens' })));
  const e2 = await failure(() => client.structured(CALL));
  check('stop_reason max_tokens fails with kind response', e2?.kind === 'response' && e2.message.includes('max_tokens'), `${e2?.kind} ${e2?.message}`);
  script.push(json(200, message({ claims: [] }, { stop_reason: 'refusal', stop_details: { category: 'cyber' } })));
  const e3 = await failure(() => client.structured(CALL));
  check('stop_reason refusal fails with kind response naming the category', e3?.kind === 'response' && e3.message.includes('cyber'), `${e3?.kind} ${e3?.message}`);
  script.push(json(200, { ...message({}), content: [] }));
  const e4 = await failure(() => client.structured(CALL));
  check('an answer without a text block fails with kind response', e4?.kind === 'response' && e4.message.includes('no text block'), `${e4?.kind} ${e4?.message}`);
  script.push((res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); });
  const e5 = await failure(() => client.structured(CALL));
  check('a 200 that is not JSON fails with kind response', e5?.kind === 'response', `${e5?.kind} ${e5?.message}`);
}

// ---------- an unknown model costs 0 (with a note on stderr) ----------
{
  const unknown = apiModelClient({ model: 'claude-test-unpriced', apiKey: KEY, baseUrl });
  script.push(json(200, message({ claims: [] })));
  const r = await unknown.structured(CALL);
  check('an unpriced model reports costUsd 0 and the tokens', r.costUsd === 0 && r.inputTokens === 1000, `${r.costUsd} ${r.inputTokens}`);
}

// ---------- retry-after parsing ----------
{
  const now = Date.parse('2026-10-25T12:00:00Z');
  check('retry-after in seconds', retryAfterMs('2') === 2000);
  check('retry-after as an HTTP date', retryAfterMs('Sun, 25 Oct 2026 12:00:03 GMT', now) === 3000);
  check('retry-after unreadable or absent is null', retryAfterMs('soon') === null && retryAfterMs(null) === null && retryAfterMs('') === null);
  check('retry-after is capped at 60 s and floored at 0', retryAfterMs('900') === 60_000 && retryAfterMs('-5') === 0);
}

// ---------- the OpenAI-compatible client (OpenRouter, Ollama /v1, NVIDIA): the same fake server, /chat/completions ----------
{
  const OKEY = 'sk-or-selfcheck-key';
  const OMODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
  const completion = (content: string, extra: Record<string, unknown> = {}, choice: Record<string, unknown> = {}) => ({ id: 'gen-1', object: 'chat.completion', model: OMODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...choice }], usage: { prompt_tokens: 2000, completion_tokens: 40 }, ...extra });
  const oclient = openaiModelClient({ model: OMODEL, baseUrl: `${baseUrl}v1/`, apiKey: OKEY, headers: { 'X-Title': 'TruthGate' }, pricePerMTok: { input: 1, output: 2 } });
  seen.length = 0;
  script.push(json(429, { error: { message: 'rate limited', code: 429 } }, { 'retry-after': '0' }), json(200, completion(JSON.stringify({ claims: [{ text: 'b' }] }))));
  const r = await oclient.structured<{ claims: unknown[] }>(CALL);
  check('openai: 429 then 200 → two requests, the parsed content, cost from the given price', seen.length === 2 && r.attempts === 2 && JSON.stringify(r.output) === JSON.stringify({ claims: [{ text: 'b' }] }) && Math.abs(r.costUsd - 0.00208) < 1e-12 && r.inputTokens === 2000, `${seen.length} ${r.attempts} ${JSON.stringify(r.output)} ${r.costUsd}`);
  const q = seen[0]!;
  const body = q.body as { model?: string; max_tokens?: number; temperature?: number; messages?: Array<{ role: string; content: string }>; response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: { additionalProperties?: boolean } } } };
  check('openai: POST /v1/chat/completions with Authorization: Bearer and the extra header', q.method === 'POST' && q.url === '/v1/chat/completions' && q.headers.authorization === `Bearer ${OKEY}` && q.headers['x-title'] === 'TruthGate', `${q.method} ${q.url} ${q.headers.authorization}`);
  check('openai: body carries the model, temperature 0, max_tokens, system + user messages', body.model === OMODEL && body.temperature === 0 && body.max_tokens === 32_000 && body.messages?.length === 2 && body.messages[0]!.role === 'system' && body.messages[0]!.content === CALL.system && body.messages[1]!.content === CALL.prompt, JSON.stringify(body).slice(0, 200));
  check('openai: response_format is a strict json_schema with additionalProperties false', body.response_format?.type === 'json_schema' && body.response_format.json_schema?.strict === true && body.response_format.json_schema.schema?.additionalProperties === false, JSON.stringify(body.response_format).slice(0, 200));
  script.push(json(200, completion('{"claims":[]}', { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } })));
  const reported = await oclient.structured<{ claims: unknown[] }>(CALL);
  check('openai: a reported usage.cost wins over the price table', Math.abs(reported.costUsd - 0.0042) < 1e-12, String(reported.costUsd));
  script.push(json(200, completion('Here it is:\n```json\n{"claims":[{"text":"c"}]}\n```')));
  const fenced = await oclient.structured<{ claims: Array<{ text: string }> }>(CALL);
  check('openai: a fenced JSON answer is parsed', fenced.output.claims[0]?.text === 'c', JSON.stringify(fenced.output));
  script.push(json(200, completion('{"claims":[', {}, { finish_reason: 'length' })));
  const cut = await failure(() => oclient.structured(CALL));
  check('openai: finish_reason length is a response failure naming max_tokens', cut?.kind === 'response' && /max_tokens/.test(cut.message), cut?.message);
  script.push(json(200, { error: { message: 'No endpoints found that support json_schema', code: 404 } }));
  const inBody = await failure(() => oclient.structured(CALL));
  check('openai: a 200 with an error body is a response failure carrying the message', inBody?.kind === 'response' && /No endpoints found/.test(inBody.message), inBody?.message);
  script.push(json(401, { error: { message: `bad key ${OKEY}`, code: 401 } }));
  const unauthorized = await failure(() => oclient.structured(CALL));
  check('openai: a 4xx is not retried and the key is scrubbed from the message', unauthorized?.kind === 'http' && unauthorized.status === 401 && unauthorized.attempts === 1 && !unauthorized.message.includes(OKEY) && unauthorized.message.includes('[api key]'), unauthorized?.message);
  script.push((res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); res.end(); });
  const redirected = await failure(() => oclient.structured(CALL));
  check('openai: a redirect is refused, the key stays with the configured origin', redirected?.kind === 'http' && redirected.status === 302, redirected?.message);
  seen.length = 0;
  script.push(json(200, completion('{"claims":[]}')));
  await openaiModelClient({ model: OMODEL, baseUrl: `${baseUrl}v1`, maxTokens: 8_000 }).structured(CALL);
  const bare = seen[0]!;
  check('openai: without a key no Authorization header is sent; maxTokens is honoured; no price → cost 0', bare.headers.authorization === undefined && (bare.body as { max_tokens?: number }).max_tokens === 8_000, JSON.stringify(bare.headers.authorization));
  const fromEnv = openaiClientFromEnv(OMODEL, { OPENAI_BASE_URL: `${baseUrl}v1`, OPENROUTER_API_KEY: OKEY, OPENAI_MAX_TOKENS: '4000' });
  check('openai: openaiClientFromEnv takes OPENAI_BASE_URL and OPENROUTER_API_KEY', fromEnv.path === 'openai' && fromEnv.model === OMODEL);
  const noBase = (() => { try { openaiClientFromEnv(OMODEL, {}); return ''; } catch (e) { return (e as Error).message; } })();
  check('openai: without OPENAI_BASE_URL the client is refused', noBase.includes('OPENAI_BASE_URL'), noBase);
  const badMax = (() => { try { openaiClientFromEnv(OMODEL, { OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', OPENAI_MAX_TOKENS: 'lots' }); return ''; } catch (e) { return (e as Error).message; } })();
  check('openai: a non-numeric OPENAI_MAX_TOKENS is refused', badMax.includes('OPENAI_MAX_TOKENS'), badMax);
}

// ---------- modelClientFromEnv ----------
{
  const fake = modelClientFromEnv(MODEL, { TRUTHGATE_MODEL_PATH: 'fake' });
  const ex = await fake.structured<{ claims: unknown[] }>(CALL);
  const judge = await fake.structured<{ verdicts: unknown[]; failures: unknown[] }>({ ...CALL, schema: { type: 'object', properties: { verdicts: {}, failures: {} } } });
  check('fake: {claims: []} for the extractor schema, {verdicts: [], failures: []} for the judge schema, cost 0', ex.output.claims.length === 0 && ex.costUsd === 0 && judge.output.verdicts.length === 0 && judge.output.failures.length === 0);
  let unknownSchema = false;
  try { await fake.structured({ ...CALL, schema: { type: 'object', properties: { other: {} } } }); } catch (e) { unknownSchema = (e as Error).message.includes('other'); }
  check('fake: an unknown schema is refused by name', unknownSchema);
  const throws = (env: NodeJS.ProcessEnv, needle: string) => { try { modelClientFromEnv(MODEL, env); return false; } catch (e) { return (e as Error).message.includes(needle); } };
  check('api without ANTHROPIC_API_KEY is refused', throws({ TRUTHGATE_MODEL_PATH: 'api' }, 'ANTHROPIC_API_KEY'));
  check('an unset or unknown TRUTHGATE_MODEL_PATH is refused', throws({}, 'not set') && throws({ TRUTHGATE_MODEL_PATH: 'sdk' }, '"sdk"'));
  check('cli gives the CLI client', modelClientFromEnv(MODEL, { TRUTHGATE_MODEL_PATH: 'cli' }).path === 'cli');
  check('api with a key gives the API client', modelClientFromEnv(MODEL, { TRUTHGATE_MODEL_PATH: 'api', ANTHROPIC_API_KEY: KEY }).path === 'api');
  check('openai with a base URL gives the OpenAI-compatible client; without one it is refused', modelClientFromEnv(MODEL, { TRUTHGATE_MODEL_PATH: 'openai', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }).path === 'openai' && throws({ TRUTHGATE_MODEL_PATH: 'openai' }, 'OPENAI_BASE_URL'));
}

for (const res of held) res.end();
server.closeAllConnections();
server.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
