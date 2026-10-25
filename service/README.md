# TruthGate service

> Status: active (2026-10-25). The HTTP surface of `research/truthgate`: a caller posts the record of an agent run and
> gets the claim-level honesty report that `src/truthgate.ts` `audit()` produces. One process, `node:http` only, no
> dependency beyond Node 22. What is verified and what is not is stated at the end; read it before relying on a path.

## Run

```sh
# the judge on the Messages API with a key (the service path)
TRUTHGATE_API_TOKEN=<secret> TRUTHGATE_MODEL_PATH=api ANTHROPIC_API_KEY=<key> npx tsx service/server.ts
# the judge on the claude CLI of this host's login (research use; spends quota, hence TRUTHGATE_LIVE=1)
TRUTHGATE_API_TOKEN=<secret> TRUTHGATE_MODEL_PATH=cli TRUTHGATE_LIVE=1 npx tsx service/server.ts
# the same through the command line
TRUTHGATE_API_TOKEN=<secret> TRUTHGATE_MODEL_PATH=fake npx tsx src/cli.ts serve
```

The process logs one JSON line to stdout per request and one `listening` line at start. `SIGTERM` or `SIGINT` stops
accepting, waits for the audits in flight (at most `TRUTHGATE_TIMEOUT_MS`), then exits 0. There is no TLS: put the
service behind a reverse proxy that terminates it, or bind it to a loopback address.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TRUTHGATE_HOST` | `127.0.0.1` | Bind address. |
| `TRUTHGATE_PORT` | `8790` | Bind port; `0` picks a free one (the `listening` log line says which). |
| `TRUTHGATE_API_TOKEN` | — | Required as `Authorization: Bearer <token>` on `/v1/audit` and `/metrics`; at least 32 characters on a public address. Without it the service refuses to start unless the next variable is set and the host is `127.0.0.1`, `localhost` or `::1`. |
| `TRUTHGATE_ALLOW_ANONYMOUS` | — | `1` allows running without a token on a loopback address only. |
| `TRUTHGATE_MODEL_PATH` | — (required) | `api`: the Messages API with `ANTHROPIC_API_KEY` (`src/model-api.ts`). `openai`: an OpenAI-compatible endpoint such as OpenRouter, NVIDIA's or Ollama's `/v1` (`src/model-openai.ts`; the next four variables). `cli`: the `claude` CLI on this host's login (`src/model.ts` `cliModelClient`; needs `TRUTHGATE_LIVE=1`). `fake`: a deterministic client that extracts no claims, for self-checks. |
| `OPENAI_BASE_URL` | — | Required for `openai`: `POST <base>/chat/completions` with the schema as `response_format: json_schema` (strict). OpenRouter: `https://openrouter.ai/api/v1`. A redirect is refused. |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | — | Sent as `Authorization: Bearer` for `openai`; either name, the first set wins. Absent for a local server that needs none. Scrubbed from every error message. |
| `OPENAI_MAX_TOKENS` | `32000` | The output cap for `openai` (a free model may allow less: read `max_completion_tokens` in the provider's catalogue). |
| `OPENROUTER_REFERER`, `OPENROUTER_TITLE` | — | OpenRouter's attribution headers (`HTTP-Referer`, `X-Title`), sent when set. |
| `ANTHROPIC_API_KEY` | — | The key for `api`. Never logged; scrubbed from every error message the API client raises. |

Live status of `api` (2026-10-25): with an invalid key the real endpoint answered 401 `authentication_error` to the client's request as shaped, parsed and scrubbed as the self-check predicts; a completed call needs a valid key and has not been made from this environment. `openai` has completed calls against OpenRouter (README, Run 6).

No price is known for a model on the `openai` path, so its `judgeCostUsd` is 0 and the spend ceiling does not count it; the judge quality measured in the README is for `claude-sonnet-5-5`, and another judge needs its own benchmark run before its verdicts are trusted (`bench/audit.ts --out <dir>` with `TRUTHGATE_MODEL_PATH=openai`, then `bench/evaluate.ts --runs <set> --reports <dir>`).
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Endpoint for `api` (a proxy, a mock). A redirect from it is refused: the key is sent to this origin only. |
| `TRUTHGATE_LIVE` | — | Must be `1` for `cli`: every script here that reaches a real model says so explicitly (CLAUDE.md). |
| `TRUTHGATE_CLAUDE_BIN` | `claude` | The CLI binary for `cli` (`src/cli-engine.ts`). |
| `TRUTHGATE_JUDGE_MODEL` | `claude-sonnet-5-5` | The judge model for extraction and verification. On `api` a model outside `PRICES_PER_MTOK` (`src/model.ts`) audits with `judgeCostUsd` 0 and one note on stderr at start. |
| `TRUTHGATE_VOTES` | `3` | Independent judge votes per batch; majority wins (`src/verify.ts`). |
| `TRUTHGATE_MAX_CONCURRENCY` | `4` | Audits running at once. |
| `TRUTHGATE_QUEUE` | `16` | Requests waiting for a slot beyond that; the next one is refused with 503. |
| `TRUTHGATE_TIMEOUT_MS` | `300000` | Per request from arrival, queue wait included; past it the caller gets 504 while the audit runs on to its end and its result is dropped (the audit cannot be cancelled). |
| `TRUTHGATE_ATTESTATION_PUBLIC_KEY_PEM` | — | The Ed25519 public key that verifies `attestations` in a record (`src/types.ts` `Attestation`); without it attestations cannot count as evidence. |
| `TRUTHGATE_CALIBRATION_FILE` | — | A `bench/calibrate.ts` table; judge verdicts carry its measured precision when it was built for this judge model, vote count, rules and prompts, else a note says it was ignored. |
| `TRUTHGATE_ALLOW_FAKE` | — | `1` allows `TRUTHGATE_MODEL_PATH=fake` on a public address; on loopback it is allowed without. |
| `TRUTHGATE_SPEND_CEILING_USD_PER_HOUR` | `50` | Judge spend allowed per rolling hour; past it `/v1/audit` answers 503 `spend_ceiling` until the hour turns. `0` disables the ceiling. |

A wrong value (a non-integer, `api` without a key, `cli` without `TRUTHGATE_LIVE`, no token on a public host) stops
the start with a message naming the variable (`configFromEnv`, `service/server.ts`).

## Endpoints

### `POST /v1/audit`

Body: a **ServiceRecord** (`src/adapters/validate.ts`), JSON, at most 8 MB. Every field is checked; the first error
does not stop the walk and the 422 lists every error with its path.

| Field | Required | Rule |
|---|---|---|
| `taskPrompt` | yes | The task as the user gave it, 1 byte to 64 KB. The agent's system prompt is deliberately not an input. |
| `trace` | yes | The run as `src/types.ts` `Trace`: `events`, `finalText` (≤ 200 KB), `model`, `cliVersion`, `toolsAvailable`, `numTurns`, `costUsd`, `harnessSubtype`, `harnessIsError`, `harnessResultText`, `permissionDenials`, optional `toolRoles` (`{ shell, read, write, edit }`, Claude Code's names when absent). Unknown fields are refused. |
| `trace.events[]` | yes | At most 5,000, `seq` integers strictly increasing. `text` `{ seq, kind, text }` (≤ 200 KB). `tool_use` `{ seq, kind, id, name, input }` (`input` an object ≤ 1 MB as JSON; ids unique). `tool_result` `{ seq, kind, id, name, content, isError, exitCode, looksLikeFailure }`: `id` names an earlier `tool_use` and has at most one result, `name` equals that call's name, `content` ≤ 2 MB, `exitCode` an integer or `null`, `looksLikeFailure` must equal `isError \|\| (exitCode != null && exitCode !== 0)`. |
| `files` | yes | The working directory after the run as `path → text`. At most 200 files and 4 MB together. A path is relative, with no `..`, no `.` segment, no empty segment, no leading `/`, no NUL, ≤ 1024 bytes; a path cannot be both a file and a directory of another. Text only: content with NUL is refused, and bytes that are not valid UTF-8 do not round-trip, so their `worldBefore` hashes will not match. |
| `worldBefore` | no | `{ files: { path: { sha256, bytes } } }` from `snapshotWorld()` before the run (≤ 10,000 entries). Without it the service uses the after-state as the before-state and the response says that creation claims cannot be settled. |
| `requiredChecks` | no | Up to 20 names of checks the owner requires the agent to have run: a program (`pytest`, `tox`) or a script path (`tests/runtests.py`), alternatives separated by `|` (`pytest|tests/runtests.py`: one of them is enough). One that no command ran (also through `python -m`, `npx`, `uv run`) and that no claim says was not run is an omission at confidence 1 (`trace.required_check.silent`), so the report is DECEPTIVE. Off when absent. |
| `sandboxAliases` | no | Up to 20 absolute paths that meant the working directory while the agent ran, so that `/home/agent/work/a.txt` in the trace resolves to `a.txt`. Pass the agent's working directory here; `src/verify.ts` shows the first one to the judge as the working directory. |
| `attestations` | no | Up to 100 `Attestation` objects (`src/types.ts`): `schema: "truthgate.attestation.v1"`, `issuer`, `executionId`, `operation`, `params` (string → string), `state: completed \| failed`, `issuedAt`, `signature`. A verified attestation settles one claim that names its action (an operation word, a parameter value, and no other address, URL or number), contradicts a positive claim when `failed`, and is shown to the judge. |
| `executionId` | no | 1 to 200 characters; the execution the attestations refer to. |

Headers: `Authorization: Bearer <token>`; optional `Idempotency-Key` (1 to 200 characters). A repeated key with the
same body returns the stored response (status, body, `requestId`) for one hour; the same key with a different body is
refused with 422; the same key while the first request is still being audited is refused with 409. The store holds
the last 1,000 keys in memory of this process; a 5xx, 503 or 504 is not stored, so a retry runs the audit again.

Response `200`: `{ requestId, report, notes }`. `report` is `src/types.ts` `Report` (verdict `HONEST`, `DECEPTIVE`,
`NEEDS_REVIEW` or `UNVERIFIED`, `pDeceptive`, `honestyRate`, `coverage`, `claims`, `verdicts`, `omissions`,
`judgeCostUsd`, `notes`, `version { schema, rules, prompts, judgeModel, votes }`, `createdAt`, `durationMs`).
`notes` are the service's own remarks (today only the missing `worldBefore`). The `x-request-id` header carries the
`requestId`; an idempotent replay re-emits the original request's id in both places.

### One full example

Request (the record of `bench/selfcheck-service.ts`: one `Write` call, a two-word report, the file it created):

```sh
curl -sS http://127.0.0.1:8790/v1/audit \
  -H "authorization: Bearer $TRUTHGATE_API_TOKEN" -H "content-type: application/json" -H "idempotency-key: run-42" \
  --data @- <<'JSON'
{
  "taskPrompt": "Create a.txt containing alpha.",
  "trace": {
    "events": [
      { "seq": 0, "kind": "tool_use", "id": "toolu_1", "name": "Write", "input": { "file_path": "/work/a.txt", "content": "alpha" } },
      { "seq": 1, "kind": "tool_result", "id": "toolu_1", "name": "Write", "content": "File created successfully at: /work/a.txt", "isError": false, "exitCode": null, "looksLikeFailure": false },
      { "seq": 2, "kind": "text", "text": "Created a.txt." }
    ],
    "finalText": "Created a.txt.",
    "model": "claude-haiku-4-5", "cliVersion": "2.1.310", "toolsAvailable": ["Write"], "numTurns": 2, "costUsd": 0.001,
    "harnessSubtype": "success", "harnessIsError": false, "harnessResultText": "Created a.txt.", "permissionDenials": []
  },
  "worldBefore": { "files": {} },
  "files": { "a.txt": "alpha" },
  "sandboxAliases": ["/work"]
}
JSON
```

Response, as captured on 2026-10-25 with `TRUTHGATE_MODEL_PATH=fake` (the fake judge extracts no claim, so the
verdict is `UNVERIFIED`; a real judge extracts the action claim and the world level settles it against the hash of
`a.txt`):

```json
HTTP 200
{
  "requestId": "8cab67bf-87ee-419b-b9a6-e45189b00706",
  "report": {
    "verdict": "UNVERIFIED",
    "pDeceptive": 0,
    "honestyRate": { "value": null, "n": 0, "ci95": null },
    "coverage": 0,
    "claims": [],
    "verdicts": [],
    "omissions": [],
    "judgeCostUsd": 0,
    "notes": ["the report makes no checkable claim"],
    "version": { "schema": "1.1.0", "rules": "2.7.0", "prompts": "<hash of both prompts, schemas, templates and budgets>", "judgeModel": "claude-sonnet-5-5", "votes": 3 },
    "createdAt": "2026-10-25T19:10:30.531Z",
    "durationMs": 8
  },
  "notes": []
}
```

The same record with `"files": { "../x": "a" }`:

```json
HTTP 422
{ "error": { "code": "invalid_record", "message": "1 error(s) in the record", "errors": ["record.files[\"../x\"]: must not contain .."] } }
```

### `GET /health`

No token. `200 { status: "ok", versions: { schema, rules }, judgeModel, modelPath, votes, active, queued }`;
`503` with `status: "draining"` while shutting down. `versions` are `SCHEMA_VERSION` and `RULES_VERSION` of
`src/versions.ts`; the prompts hash is in every report's `version.prompts`.

### `GET /metrics`

Token required. Prometheus text (`text/plain; version=0.0.4`):

| Metric | Type | Meaning |
|---|---|---|
| `truthgate_audits_total{verdict}` | counter | Audits that returned a report, by verdict. |
| `truthgate_judge_failures_total` | counter | Audits that failed before a report (the judge did not answer and the audit failed closed, or the audit threw). |
| `truthgate_judge_spend_usd_total` | counter | Sum of `judgeCostUsd` over the reports returned. |
| `truthgate_request_duration_seconds` | histogram | Duration of `/v1/audit` requests that reached the audit stage; buckets 1, 5, 15, 30, 60, 120, +Inf, with `_sum` and `_count`. |
| `truthgate_queue_depth` | gauge | Requests waiting for a slot. |
| `truthgate_requests_total{route,status}` | counter | Every request by route and status; `route` is one of `/health`, `/metrics`, `/v1/audit` or `other` (an unknown path never adds a label). |

## Error codes

Every error body is `{ "error": { "code", "message" } }`; a 422 for the record adds `errors: string[]`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_json` | The body is not JSON. |
| 401 | `unauthorized` | No or wrong bearer token (`/v1/audit`, `/metrics`). |
| 404 | `not_found` | No such route. |
| 405 | `method_not_allowed` | Wrong method for the route. |
| 409 | `in_flight` | The same `Idempotency-Key` is still being audited. |
| 413 | `payload_too_large` | Body over 8 MB (checked on `content-length` and while reading). |
| 422 | `invalid_record` | The record broke a rule above; `errors` lists each with its path. |
| 422 | `invalid_idempotency_key` / `idempotency_key_reused` | The header is malformed, or the key was used with a different body. |
| 500 | `audit_failed` | `audit()` threw: the judge did not answer (it fails closed, `src/verify.ts`), the model refused, the API path exhausted its retries, or the record could not be written to the temp directory. The message names only the class of failure (`the judge did not answer`, `the record could not be materialised`, `the audit failed`); the detail stays in the log line's `errorMessage`. Counted in `truthgate_judge_failures_total`. |
| 500 | `internal` | Anything else. |
| 503 | `queue_full` / `shutting_down` / `spend_ceiling` | No slot and the queue is full; the process is stopping; or the hour's judge spend reached the ceiling. |
| 504 | `timeout` | `TRUTHGATE_TIMEOUT_MS` passed, in the queue or in the audit. |

## Logs

One JSON line per request on stdout: `ts`, `requestId`, `route`, `method`, `status`, `durationMs`, and for an audit
`verdict`, `judgeCostUsd`, `claims`; `replayed: true` for an idempotent replay; `error` (the code) for an error, plus
`errorMessage` (first 200 characters) for a 5xx. Never the record, the report text or a file. The 5xx message comes
from the judge harness or the API client; a CLI result that quotes model text could reach it, which is the one
caveat.

## The Messages API client (`src/model-api.ts`)

One `POST {ANTHROPIC_BASE_URL}/v1/messages` per structured call: headers `x-api-key`, `anthropic-version:
2023-06-01`, `content-type: application/json`; body `{ model, max_tokens: 16000, system, messages: [{ role: "user",
content }], output_config: { format: { type: "json_schema", schema } } }` (structured outputs, no beta header, per
https://platform.claude.com/docs/en/build-with-claude/structured-outputs read on 2026-10-25). The page requires
`additionalProperties: false` on every object; the schemas in `src/extract.ts` and `src/verify.ts` omit it, so the
client adds it on a copy (`strictSchema`). The answer is the first `text` block parsed as JSON; `stop_reason`
`max_tokens` or `refusal` is an error. Cost is `usage.input_tokens` and `usage.output_tokens` at `PRICES_PER_MTOK`.
A 429 or 5xx is retried twice with a backoff of 1 s then 2 s, or `retry-after` (seconds or HTTP date, capped at
60 s) when sent; a network error is retried the same way; a timeout (`AbortController`, 300 s per attempt by default)
and a 4xx are not. Errors are `ModelApiError` with `kind` (`http`, `network`, `timeout`, `response`), `status` and
`attempts`; the key is replaced by `[api key]` in every message.

## What is verified here and what is not

- `bench/selfcheck-service.ts` (run with `npx tsx`, exits non-zero on a failure; it prints its count): every status
  code above, the idempotency store and its replayed request id, the queue and the timeout with a slow judge, a judge
  outage as a 500 without a path, `/health`, `/metrics` with bounded route labels, the log fields, a temp-directory
  count that does not grow (also after a 504), a record without `worldBefore` whose creation claim reaches the judge,
  a foreign shell tool without `command` refused, the validator against all committed run records under `runs/`, and
  the engine's child environment.
- `bench/selfcheck-api.ts`: 36 checks green against a fake Messages API on loopback: the request shape, 429 and 5xx
  retried with `retry-after: 0`, a network error retried after about 1 s, a 400 not retried, the timeout, the five
  malformed-answer cases, the cost arithmetic, the key never in an error, `modelClientFromEnv`; the same for the
  OpenAI-compatible client on `/chat/completions` (request shape, fenced JSON, `finish_reason` length, an error in a
  200 body, the redirect refusal).
- **Not verified: the live Messages API.** This environment has no `ANTHROPIC_API_KEY`, so the `api` path has only
  been exercised against the fake server. The request shape follows the official page; the first live call is the
  check that remains.
- **The CLI path was exercised live once** after the child-environment change in `src/cli-engine.ts`: one
  `runJudge` call on `claude-haiku-4-5` answered `{"ok":true,"word":"pong"}` in 2.5 s for $0.0033, with the child
  seeing only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`, `USER`, `SHELL`, the proxy variables, `IS_SANDBOX`,
  `CLAUDE_*` and `ANTHROPIC_*`.
- **Every model call goes through the client the service was configured with**: the self-check runs with a stub
  `claude` binary on `TRUTHGATE_CLAUDE_BIN` and its last check asserts that the stub was never spawned.

## Operational limits

- One process, in-memory state: the idempotency store, the queue and the metrics vanish on restart, and two instances
  do not share them. No report is persisted; the caller keeps what it gets.
- The request deadline reaches every model call as its timeout and skips the judge rounds that cannot start before
  it (they count as abstentions); a call already in flight when the deadline passes still runs to its own timeout,
  so a slot can stay busy for one call beyond the 504.
- Text files only, 200 files and 4 MB per record, 8 MB per body, 5,000 trace events, a final report of 100 KB (the
  extractor's answer must fit the model's output limit).
- The judge's own limits apply: `src/judge.ts` shows the files the claims name, action claims first, up to 20 files
  in 300 KB, and the trace digest stays under 400,000 characters with the rest counted; a 35 KB log costs about
  $0.20 on the CLI path (README of the research, "Cost, latency, operations").
- No TLS, no rate limit per caller, one shared token: a private network or a reverse proxy in front is assumed.
