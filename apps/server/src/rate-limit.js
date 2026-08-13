export function createRateLimiter() {
  const buckets = new Map();
  return function allow(key, limit, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const recent = (buckets.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      buckets.set(key, recent);
      return false;
    }
    recent.push(now);
    buckets.set(key, recent);
    return true;
  };
}
