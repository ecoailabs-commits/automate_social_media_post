export class PlatformError extends Error {
  constructor(platform, message, { status = null, retryable = false, details = null } = {}) {
    super(`[${platform}] ${message}`);
    this.platform = platform;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch wrapper with timeout, JSON handling and exponential backoff on 429/5xx/network errors.
 * `extractError(body)` turns a platform error payload into a human-readable message.
 */
export async function request(platform, url, {
  method = 'GET', headers = {}, body, json, timeoutMs = 60_000, retries = 3, extractError, raw = false,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init = { method, headers: { ...headers }, signal: ctrl.signal };
      if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
      } else if (body !== undefined) {
        init.body = body;
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (res.ok) return raw ? { data, headers: res.headers, status: res.status } : data;

      const retryable = res.status === 429 || res.status >= 500;
      const msg = (extractError && data && extractError(data)) || `HTTP ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data)?.slice(0, 500)}`;
      lastErr = new PlatformError(platform, msg, { status: res.status, retryable, details: data });
      if (!retryable || attempt === retries) throw lastErr;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      lastErr = new PlatformError(platform, e.name === 'AbortError' ? 'Request timed out' : `Network error: ${e.message}`, { retryable: true });
      if (attempt === retries) throw lastErr;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
