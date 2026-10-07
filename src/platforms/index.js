import * as meta from './meta.js';
import * as google from './google.js';

export const adapters = { meta, google };
export const PLATFORM_NAMES = { meta: 'Meta Ads', google: 'Google Ads' };

export function adapter(platform) {
  const a = adapters[platform];
  if (!a) throw new Error(`Unknown platform ${platform}`);
  return a;
}
