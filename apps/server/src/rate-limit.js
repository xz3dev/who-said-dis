export function createRateLimiter(options = {}) {
  const buckets = new Map();
  const maxKeys = options.maxKeys || 10_000;
  const sweepIntervalMs = options.sweepIntervalMs || 60_000;
  let nextSweepAt = 0;

  return function allow(key, limit, windowMs, now = Date.now()) {
    if (now >= nextSweepAt) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(bucketKey);
      }
      nextSweepAt = now + sweepIntervalMs;
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      if (!bucket && buckets.size >= maxKeys) return false;
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  };
}
