import { config } from '../config.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// Strict schema enforcement is only offered on some Groq models; others get best-effort JSON.
const supportsStrict = (model) => model.startsWith('openai/gpt-oss');

/**
 * One structured-output call to Groq (OpenAI-compatible API). Returns the parsed JSON object matching `schema`.
 * Same contract as the Claude `generateJSON`, so callers don't care which provider runs.
 */
export async function groqJSON({ system, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  const { apiKey, model } = config.groq;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set on the server.');

  const body = {
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: `${system}\n\nRespond only with a JSON object that matches the provided schema.` },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: supportsStrict(model) } },
  };
  if (supportsStrict(model)) body.reasoning_effort = effort === 'high' ? 'high' : 'medium';

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch {
      throw new Error('Could not reach the Groq API (network error).');
    }
    // Retry rate limits and transient server errors, like the Anthropic SDK does.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      continue;
    }
    // A schema strict mode can't handle: fall back once to best-effort JSON.
    if (res.status === 400 && body.response_format.json_schema.strict) {
      body.response_format.json_schema.strict = false;
      continue;
    }
    break;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    if (res.status === 401) throw new Error('Groq API key was rejected. Check GROQ_API_KEY.');
    if (res.status === 429) throw new Error('Groq API rate limit reached. Try again shortly.');
    if (res.status === 400) throw new Error(`Groq API rejected the request: ${msg}`);
    throw new Error(`Groq API error ${res.status}: ${msg}`);
  }

  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('AI response was cut off (max tokens). Try fewer variations.');
  try {
    return JSON.parse(choice?.message?.content ?? '');
  } catch {
    throw new Error('AI returned malformed JSON. Please retry.');
  }
}
