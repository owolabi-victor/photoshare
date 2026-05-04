import redis from '../redis.js';

/*
 * Token Bucket rate limiting algorithm implemented with a Lua script.
 *
 * The Lua script runs atomically in Redis — no other Redis command
 * can execute between lines of the script. This eliminates race
 * conditions when multiple servers check the same user's token count
 * simultaneously.
 *
 * Keys used per identifier:
 *   ratelimit:{id}:tokens      — current token count (float)
 *   ratelimit:{id}:last_refill — unix timestamp of last refill (ms)
 */
const TOKEN_BUCKET_SCRIPT = `
  local tokens_key = KEYS[1]
  local last_refill_key = KEYS[2]
  local capacity = tonumber(ARGV[1])
  local refill_rate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local requested = tonumber(ARGV[4])

  -- Get current state from Redis
  local last_tokens = tonumber(redis.call('get', tokens_key))
  local last_refill = tonumber(redis.call('get', last_refill_key))

  -- First request from this identifier — start with a full bucket
  if last_tokens == nil then
    last_tokens = capacity
  end
  if last_refill == nil then
    last_refill = now
  end

  -- Calculate tokens to add based on time elapsed since last refill
  local elapsed = math.max(0, now - last_refill)
  local new_tokens = math.min(capacity, last_tokens + (elapsed * refill_rate / 1000))

  -- Check if request can be served
  local allowed = 0
  if new_tokens >= requested then
    new_tokens = new_tokens - requested
    allowed = 1
  end

  -- Persist updated state with expiry (capacity / refill_rate seconds + buffer)
  local ttl = math.ceil(capacity / refill_rate) + 10
  redis.call('setex', tokens_key, ttl, new_tokens)
  redis.call('setex', last_refill_key, ttl, now)

  return { allowed, math.floor(new_tokens) }
`;

/*
 * Creates a rate limiter middleware with the given configuration.
 *
 * @param {object} options
 * @param {number} options.capacity      - Maximum tokens in bucket
 * @param {number} options.refillRate    - Tokens added per second
 * @param {string} options.keyPrefix     - Namespace for Redis keys
 * @param {function} options.identifier  - Function to extract identifier from req
 */
function createRateLimiter({ capacity, refillRate, keyPrefix, identifier }) {
  return async function rateLimiterMiddleware(req, res, next) {
    const id = identifier(req);
    const tokensKey = `ratelimit:${keyPrefix}:${id}:tokens`;
    const lastRefillKey = `ratelimit:${keyPrefix}:${id}:last_refill`;
    const now = Date.now();

    try {
      const result = await redis.eval(
        TOKEN_BUCKET_SCRIPT,
        2,
        tokensKey,
        lastRefillKey,
        capacity,
        refillRate,
        now,
        1
      );

      const allowed = result[0] === 1;
      const remainingTokens = result[1];

      // Inform the client of their rate limit status via headers
      res.set('X-RateLimit-Limit', capacity);
      res.set('X-RateLimit-Remaining', remainingTokens);
      res.set('X-RateLimit-Policy', `${capacity};w=${Math.ceil(capacity / refillRate)}`);

      if (!allowed) {
        // Calculate when the next token will be available
        const retryAfterSeconds = Math.ceil(1 / refillRate);
        res.set('X-RateLimit-Retry-After', retryAfterSeconds);
        res.set('Retry-After', retryAfterSeconds);

        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded. Try again in ${retryAfterSeconds} second(s).`,
          retryAfter: retryAfterSeconds
        });
      }

      next();
    } catch (error) {
      // If Redis is down, fail open — let the request through
      // A degraded rate limiter is better than a completely broken API
      console.error('Rate limiter error:', error.message);
      next();
    }
  };
}

export default createRateLimiter;