import { generateJSON } from './claude.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions'],
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'priority', 'action', 'platform', 'variation_id', 'new_daily_budget'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string', description: 'Reasoning grounded in the numbers provided' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { type: 'string', enum: ['none', 'pause_variation', 'adjust_daily_budget'] },
          platform: { type: 'string', enum: ['meta', 'google', 'all'] },
          variation_id: { type: 'integer', description: 'Required for pause_variation, otherwise 0' },
          new_daily_budget: { type: 'number', description: 'Required for adjust_daily_budget (whole campaign daily budget, all platforms), otherwise 0' },
        },
      },
    },
  },
};

const SYSTEM = `You are a paid-media optimisation analyst. You receive real performance data for one campaign.
Give concrete, conservative recommendations grounded only in the numbers provided.
Do not recommend pausing a variation without statistically meaningful data (as a rule of thumb, at least ~1000 impressions or meaningful spend on it and a clearly worse result than siblings).
Never propose a daily budget above the hard cap provided. If data is too thin, say so and suggest waiting (action "none").
Return at most 6 suggestions, highest impact first.`;

export async function analyseCampaign({ campaign, totals, byVariation, byPlatform, daily, caps }) {
  const prompt = `Campaign: ${campaign.name}
Objective: ${campaign.objective}
Platforms: ${campaign.platforms.join(', ')}
Flight: ${campaign.start_at} → ${campaign.end_at}
Budget: total ${campaign.total_budget} ${campaign.currency}, current daily ${campaign.daily_budget} ${campaign.currency}
Hard cap on daily budget: ${caps.maxDaily} ${campaign.currency}. Remaining total budget: ${caps.remaining} ${campaign.currency}.

Totals: ${JSON.stringify(totals)}
By platform: ${JSON.stringify(byPlatform)}
By variation (variation_id, label, platform metrics): ${JSON.stringify(byVariation)}
Daily trend (last 14 days): ${JSON.stringify(daily)}`;

  return generateJSON({ system: SYSTEM, prompt, schema: SCHEMA, effort: 'high' });
}
