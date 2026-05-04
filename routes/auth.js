import express from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getShardForUser, getAllShards } from '../shardRouter.js';
import redis from '../redis.js';
import authenticate from '../middleware/auth.js';
import createRateLimiter from '../middleware/rateLimiter.js';

const router = express.Router();

/*
 * Rate limiter for registration — 5 attempts per hour per IP.
 * Registration is expensive (bcrypt hashing) so we protect it
 * aggressively. IP is used as identifier because the user has
 * no session token yet at registration time.
 */
const registerLimiter = createRateLimiter({
  capacity: 5,
  refillRate: 5 / 3600,
  keyPrefix: 'register',
  identifier: (req) => req.headers['x-real-ip'] || req.ip
});

/*
 * Rate limiter for login — 10 attempts per 15 minutes per IP.
 * Replaces the manual Redis counter from Chapter 1.
 * Token bucket allows an initial burst then throttles to the refill rate.
 */
const loginLimiter = createRateLimiter({
  capacity: 10,
  refillRate: 10 / 900,
  keyPrefix: 'login',
  identifier: (req) => req.headers['x-real-ip'] || req.ip
});

// REGISTER
router.post('/register', registerLimiter, async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, 10);

    // Check if email or username exists across ALL shards before inserting.
    // Database uniqueness constraints only work within one shard so we
    // enforce uniqueness at the application layer.
    const allShards = getAllShards();
    for (const shard of allShards) {
      const [rows] = await shard.query(
        'SELECT id FROM users WHERE email = ? OR username = ?',
        [email, username]
      );
      if (rows.length > 0) {
        return res.status(400).json({ error: 'Username or email already exists' });
      }
    }

    // Insert into shard 0 first to get the auto-increment id.
    // We need the id before we can determine the correct shard.
    const shard0 = getShardForUser(0);
    const [result] = await shard0.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, password_hash]
    );

    const userId = result.insertId;

    // If the generated id belongs to shard 1, move the record there
    // and delete it from shard 0.
    const correctShard = getShardForUser(userId);
    if (userId % 2 !== 0) {
      await correctShard.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
        [userId, username, email, password_hash]
      );
      await shard0.query('DELETE FROM users WHERE id = ?', [userId]);
    }

    res.status(201).json({
      message: 'User registered successfully',
      shard: userId % 2
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// LOGIN
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    // Search across all shards for the user by email.
    // We do not know which shard holds this user so we fan out
    // across all shards and stop at the first match.
    let user = null;
    let userShard = null;
    const allShards = getAllShards();

    for (const shard of allShards) {
      const [rows] = await shard.query(
        'SELECT * FROM users WHERE email = ?',
        [email]
      );
      if (rows.length > 0) {
        user = rows[0];
        userShard = shard;
        break;
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = uuidv4();

    // Store session in the same shard as the user for data locality.
    const sessionShard = getShardForUser(user.id);
    await sessionShard.query(
      'INSERT INTO sessions (user_id, token) VALUES (?, ?)',
      [user.id, token]
    );

    // Cache session in Redis so subsequent requests skip the database.
    const sessionData = {
      id: user.id,
      username: user.username,
      email: user.email
    };
    await redis.set(`session:${token}`, JSON.stringify(sessionData), 'EX', 86400);

    res.status(200).json({
      message: 'Login successful',
      token,
      user: sessionData,
      shard: user.id % 2
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// LOGOUT
router.post('/logout', authenticate, async (req, res) => {
  const token = req.headers['authorization'];

  try {
    // Delete from Redis immediately — this is what actually invalidates
    // the session across all servers instantly.
    await redis.del(`session:${token}`);

    // Delete from the correct shard for clean record keeping.
    const shard = getShardForUser(req.user.id);
    await shard.query(
      'DELETE FROM sessions WHERE token = ?',
      [token]
    );

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;