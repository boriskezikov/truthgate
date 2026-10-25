// Which client the environment asks for: TRUTHGATE_MODEL_PATH decides, and each path names its own variables.
//   api     the Messages API (ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL overrides the endpoint)                   model-api.ts
//   openai  an OpenAI-compatible endpoint (OPENAI_BASE_URL; OPENAI_API_KEY or OPENROUTER_API_KEY)           model-openai.ts
//   cli     the claude CLI on this host's login (TRUTHGATE_LIVE=1 at call time)                             model.ts
//   fake    a deterministic client that extracts no claims, for self-checks                                 model-api.ts
import { apiModelClient, fakeModelClient } from './model-api.ts';
import { openaiClientFromEnv } from './model-openai.ts';
import { cliModelClient } from './model.ts';
import type { ModelClient } from './model.ts';

export function modelClientFromEnv(model: string, env: NodeJS.ProcessEnv = process.env): ModelClient {
  const path = env.TRUTHGATE_MODEL_PATH;
  if (path === 'api') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('TRUTHGATE_MODEL_PATH=api needs ANTHROPIC_API_KEY');
    return apiModelClient({ model, apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL });
  }
  if (path === 'openai') return openaiClientFromEnv(model, env);
  if (path === 'cli') return cliModelClient(model);
  if (path === 'fake') return fakeModelClient(model);
  throw new Error(`TRUTHGATE_MODEL_PATH must be api, openai, cli or fake; it is ${path === undefined ? 'not set' : JSON.stringify(path)}`);
}
