import { generateJSON } from './claude.js';

export const CTAS = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'GET_QUOTE', 'DOWNLOAD', 'APPLY_NOW', 'SUBSCRIBE'];
export const LAYOUTS = ['left', 'center', 'bottom'];

const str = { type: 'string' };
const strArr = { type: 'array', items: str };

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overlay_headline', 'overlay_subtext', 'badge', 'bg_from', 'bg_to', 'accent', 'text_color', 'layout'],
  properties: {
    overlay_headline: { ...str, description: 'Max 40 chars. Large text on the image.' },
    overlay_subtext: { ...str, description: 'Max 70 chars.' },
    badge: { ...str, description: 'Max 18 chars, e.g. "20% OFF" or "NEW". Empty string for none.' },
    bg_from: { ...str, description: 'Hex color #RRGGBB' },
    bg_to: { ...str, description: 'Hex color #RRGGBB' },
    accent: { ...str, description: 'Hex color #RRGGBB for CTA button and badge' },
    text_color: { ...str, description: 'Hex color #RRGGBB with strong contrast against the background' },
    layout: { type: 'string', enum: LAYOUTS },
  },
};

const VARIATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'angle', 'primary_text', 'headlines', 'descriptions', 'cta', 'design'],
  properties: {
    label: { ...str, description: 'Short name, e.g. "Pain point" or "Social proof"' },
    angle: { ...str, description: 'One sentence on the persuasion angle' },
    primary_text: { ...str, description: 'Main ad body text, 80-250 chars' },
    headlines: { ...strArr, description: '5-10 headlines, EACH at most 30 characters' },
    descriptions: { ...strArr, description: '2-4 descriptions, EACH at most 90 characters' },
    cta: { type: 'string', enum: CTAS },
    design: DESIGN_SCHEMA,
  },
};

const GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'variations'],
  properties: {
    strategy: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'audience_insights', 'meta_interests', 'google_keywords', 'negative_keywords'],
      properties: {
        summary: str,
        audience_insights: str,
        meta_interests: { ...strArr, description: '3-8 Facebook interest names to target' },
        google_keywords: { ...strArr, description: '10-20 high-intent search keywords' },
        negative_keywords: { ...strArr, description: '3-10 negative keywords' },
      },
    },
    variations: { type: 'array', items: VARIATION_SCHEMA },
  },
};

const SYSTEM = `You are a senior performance-marketing copywriter and media buyer.
You write ad copy that is specific, benefit-led, truthful, and compliant with Meta and Google Ads advertising policies:
no unverifiable superlatives ("#1", "best") unless the brief supplies evidence, no personal-attribute assertions ("Are you overweight?"),
no excessive capitalisation or punctuation, no misleading urgency, no prohibited or restricted claims (health cures, guaranteed income).
Only use facts present in the brief; never invent prices, discounts, statistics or testimonials. If the brief gives an offer, you may use it.
Each variation must take a clearly different persuasion angle so they can be A/B tested meaningfully.
Hard limits that platforms enforce: every headline <= 30 characters, every description <= 90 characters. Count characters carefully.
Design colours must be valid #RRGGBB hex with high text contrast.`;

function brief(input) {
  return `Product / service: ${input.product}
Details: ${input.description || '(none)'}
Landing page: ${input.landing_url}
Target audience: ${input.audience}
Locations: ${input.locationText || '(see targeting)'}
Objective: ${input.objective}
Platforms: ${input.platforms.join(', ')}
Total budget: ${input.total_budget} ${input.currency} over ${input.days} days
Brand tone: ${input.tone || 'professional, friendly'}
Copy language: ${input.language || 'English'}`;
}

export function validateCopy(v) {
  const issues = [];
  if (v.headlines.length < 3) issues.push(`"${v.label}": needs at least 3 headlines`);
  if (v.descriptions.length < 2) issues.push(`"${v.label}": needs at least 2 descriptions`);
  v.headlines.forEach((h) => h.length > 30 && issues.push(`"${v.label}" headline is ${h.length} chars (max 30): "${h}"`));
  v.descriptions.forEach((d) => d.length > 90 && issues.push(`"${v.label}" description is ${d.length} chars (max 90): "${d}"`));
  if (!/^#[0-9a-fA-F]{6}$/.test(v.design?.bg_from ?? '')) issues.push(`"${v.label}": invalid bg_from colour`);
  return issues;
}

/** Generates strategy + N copy/design variations, with one automatic repair pass for length violations. */
export async function generateCampaignCopy(input, count) {
  const prompt = `${brief(input)}

Create a targeting strategy and exactly ${count} distinct ad variations for this brief.`;
  let out = await generateJSON({ system: SYSTEM, prompt, schema: GENERATION_SCHEMA, effort: 'medium' });

  let issues = out.variations.flatMap(validateCopy);
  if (issues.length) {
    out = await generateJSON({
      system: SYSTEM,
      schema: GENERATION_SCHEMA,
      effort: 'medium',
      prompt: `${prompt}

A previous draft broke these platform limits. Return the complete corrected output, keeping everything else the same:
${issues.join('\n')}

Previous draft:
${JSON.stringify(out)}`,
    });
    issues = out.variations.flatMap(validateCopy);
  }
  // Final guard: drop any over-limit asset rather than ship something the platforms will reject.
  for (const v of out.variations) {
    v.headlines = v.headlines.filter((h) => h.length <= 30);
    v.descriptions = v.descriptions.filter((d) => d.length <= 90);
  }
  return { ...out, warnings: issues };
}

/** Regenerate a single variation with optional user guidance. */
export async function regenerateVariation(input, existing, guidance) {
  const schema = { type: 'object', additionalProperties: false, required: ['variation'], properties: { variation: VARIATION_SCHEMA } };
  const out = await generateJSON({
    system: SYSTEM,
    schema,
    effort: 'medium',
    prompt: `${brief(input)}

Rewrite this ad variation. ${guidance ? `Guidance from the marketer: ${guidance}` : 'Make it stronger and more specific.'}
Current variation:
${JSON.stringify(existing)}`,
  });
  const v = out.variation;
  v.headlines = v.headlines.filter((h) => h.length <= 30);
  v.descriptions = v.descriptions.filter((d) => d.length <= 90);
  return v;
}
