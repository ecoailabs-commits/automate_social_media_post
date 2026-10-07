import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
function getClient() {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 3, timeout: 5 * 60_000 });
  return client;
}

/**
 * One structured-output call to Claude. Returns the parsed JSON object matching `schema`.
 * Server-side refusal fallback is enabled so a policy decline is retried on Anthropic's recommended model.
 */
export async function generateJSON({ system, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit reached. Try again shortly.');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude API rejected the request: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API (network error).');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined to generate this content${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'} Review the product/audience description for policy issues.`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('AI response was cut off (max_tokens). Try fewer variations.');

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('AI returned malformed JSON. Please retry.');
  }
}
