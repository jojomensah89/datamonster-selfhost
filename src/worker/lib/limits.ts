import type { Context, Next } from 'hono';

/** A counter per key in this isolate's memory, reset each window. Costs nothing to refuse; bounded so made-up keys can't fill it. */
export function memoryLimiter(max: number, windowMs: number, maxKeys = 5000) {
  let window = 0;
  let hits = new Map<string, number>();
  return (key: string, now = Date.now()): boolean => {
    const w = Math.floor(now / windowMs);
    if (w !== window) {
      window = w;
      hits = new Map();
    }
    const n = (hits.get(key) ?? 0) + 1;
    if (n === 1 && hits.size >= maxKeys) hits.delete(hits.keys().next().value!);
    hits.set(key, n);
    return n <= max;
  };
}

const KB = 1024;

/** The largest body each kind of route may receive. */
export function maxBody(path: string): number {
  if (path === '/api/event') return 32 * KB;
  if (path.startsWith('/api/webhooks/') || path === '/api/billing/webhook') return 1024 * KB;
  if (path.startsWith('/oauth/') || path.startsWith('/api/auth/')) return 16 * KB;
  return 256 * KB;
}

/** Refuses a body over the route's limit before anything reads it, also when it doesn't announce its size. */
export async function limitBody(c: Context, next: Next) {
  const raw = c.req.raw;
  if (!raw.body) return next();
  const max = maxBody(c.req.path);
  const declared = c.req.header('content-length');
  if (declared !== undefined && !c.req.header('transfer-encoding')) {
    if (!(Number(declared) <= max)) return c.json({ error: 'request body is too large' }, 413);
    return next();
  }
  const reader = raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return c.json({ error: 'request body is too large' }, 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  // The body has been read, so hand on a copy. Cloudflare's details (location) are not part of a plain copy.
  const copy = new Request(raw.url, { method: raw.method, headers: raw.headers, body });
  const cf = (raw as { cf?: unknown }).cf;
  if (cf) Object.defineProperty(copy, 'cf', { value: cf });
  c.req.raw = copy;
  return next();
}
