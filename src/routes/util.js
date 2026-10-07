import { PlatformError } from '../platforms/http.js';

/** Wraps an async handler so thrown errors become JSON responses with sensible status codes. */
export const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    const status = e.status ?? (e instanceof PlatformError ? 502 : 500);
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, e);
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Unexpected error' });
  }
};

export const httpError = (status, message) => Object.assign(new Error(message), { status });

export const intParam = (v) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw httpError(400, 'Invalid id');
  return n;
};
