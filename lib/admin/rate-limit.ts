/**
 * In-memory rate limiter for admin login.
 * Max 5 attempts per IP per 15 minutes, and 50 across all clients. A browser
 * with the admin device cookie (lib/admin/session.ts) gets 5 per device
 * instead and stays out of the shared ceiling, which anyone can use up.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Ceiling across all clients. The per-IP key comes from X-Forwarded-For
 * (getClientIP), which a client can write itself when the app is reachable
 * without a reverse proxy in front: Next fills the header from the socket
 * only when the request carries none. Rotating forged addresses would
 * otherwise buy unlimited guesses. 50 per window still leaves room for a
 * few admins mistyping at once.
 */
const GLOBAL_MAX_ATTEMPTS = 50;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, RateLimitEntry>();
const deviceAttempts = new Map<string, RateLimitEntry>();
let globalAttempts: RateLimitEntry | null = null;

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const map of [attempts, deviceAttempts]) {
    for (const [key, entry] of map) {
      if (entry.resetAt <= now) {
        map.delete(key);
      }
    }
  }
}, 60_000).unref();

/**
 * Check if the IP is rate limited. Returns remaining attempts, or 0 if blocked.
 */
export function checkRateLimit(ip: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();

  if (!globalAttempts || globalAttempts.resetAt <= now) {
    globalAttempts = { count: 0, resetAt: now + WINDOW_MS };
  }
  if (globalAttempts.count >= GLOBAL_MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0, retryAfterMs: globalAttempts.resetAt - now };
  }

  const entry = attempts.get(ip);

  if (!entry || entry.resetAt <= now) {
    // New window
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    globalAttempts.count++;
    return { allowed: true, remaining: MAX_ATTEMPTS - 1, retryAfterMs: 0 };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  globalAttempts.count++;
  return { allowed: true, remaining: MAX_ATTEMPTS - entry.count, retryAfterMs: 0 };
}

/**
 * Check a browser with a valid admin device cookie, by its device id: 5
 * attempts per 15 minutes, not counted against or stopped by the shared
 * ceiling.
 */
export function checkDeviceRateLimit(deviceId: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const entry = deviceAttempts.get(deviceId);

  if (!entry || entry.resetAt <= now) {
    deviceAttempts.set(deviceId, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1, retryAfterMs: 0 };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: MAX_ATTEMPTS - entry.count, retryAfterMs: 0 };
}
