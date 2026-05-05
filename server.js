import express from 'express';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';
import redis from './redis.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const REGION = process.env.REGION || 'us-east';

// Structured logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      region: REGION,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      instance: PORT
    }));
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads', {
  maxAge: 0,
  etag: false,
  lastModified: false
}));

// Routes
app.use('/auth', authRoutes);
app.use('/photos', photoRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Photoshare API is running',
    instance: PORT,
    region: REGION,
    timestamp: new Date().toISOString()
  });
});

/*
 * Rate limit metrics endpoint — shows current token bucket state
 * for all active rate limit keys in Redis. Used to monitor whether
 * limits are too aggressive or too loose in production.
 *
 * In a real system this would be protected and consumed by a
 * monitoring tool like Datadog or Grafana. We expose it openly
 * here for development visibility only.
 */
app.get('/metrics/ratelimits', async (req, res) => {
  try {
    // Find all active rate limit keys in Redis
    const keys = await redis.keys('ratelimit:*:tokens');

    if (keys.length === 0) {
      return res.status(200).json({
        message: 'No active rate limit buckets',
        buckets: []
      });
    }

    // Build a report for each active bucket
    const buckets = await Promise.all(
      keys.map(async (tokenKey) => {
        const tokens = await redis.get(tokenKey);
        const ttl = await redis.ttl(tokenKey);

        // Extract identifier from key format: ratelimit:{prefix}:{id}:tokens
        const parts = tokenKey.split(':');
        const prefix = parts[1];
        const identifier = parts.slice(2, -1).join(':');

        return {
          prefix,
          identifier,
          tokens_remaining: parseFloat(tokens).toFixed(2),
          expires_in_seconds: ttl
        };
      })
    );

    res.status(200).json({
      total_active_buckets: buckets.length,
      buckets: buckets.sort((a, b) => a.tokens_remaining - b.tokens_remaining)
    });
  } catch (error) {
    console.error('Metrics error:', error.message);
    res.status(500).json({ error: 'Could not retrieve metrics' });
  }
});

// Detailed health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    region: REGION,
    instance: PORT,
    timestamp: new Date().toISOString(),
    checks: {
      server: 'up',
    }
  };
  res.status(200).json(health);
});

app.listen(PORT, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    region: REGION,
    message: `Server running on port ${PORT}`,
    instance: PORT
  }));
});