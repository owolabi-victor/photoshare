import express from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getShardForUser, getAllShards } from '../shardRouter.js';
import redis from '../redis.js';
import authenticate from '../middleware/auth.js';

const router = express.Router();

// REGISTER
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, 10);

    // First check if email exists across ALL shards
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

    // Insert into shard 0 first to get the auto-increment id
    const shard0 = getShardForUser(0);
    const [result] = await shard0.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, password_hash]
    );

    const userId = result.insertId;
    
    // If user belongs to shard 1, insert there instead
    const correctShard = getShardForUser(userId);
    if (userId % 2 !== 0) {
      // Move to correct shard
      await correctShard.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
        [userId, username, email, password_hash]
      );
      // Delete from shard 0
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
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const rateLimitKey = `ratelimit:login:${email}`;

  try {
    // Check rate limit
    const attempts = await redis.get(rateLimitKey);
    if (attempts && parseInt(attempts) >= 5) {
      return res.status(429).json({ 
        error: 'Too many login attempts. Try again in 15 minutes.' 
      });
    }

    // Search across all shards for the user
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
      await redis.incr(rateLimitKey);
      await redis.expire(rateLimitKey, 900);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await redis.incr(rateLimitKey);
      await redis.expire(rateLimitKey, 900);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await redis.del(rateLimitKey);

    const token = uuidv4();

    // Store session in correct shard
    const sessionShard = getShardForUser(user.id);
    await sessionShard.query(
      'INSERT INTO sessions (user_id, token) VALUES (?, ?)',
      [user.id, token]
    );

    // Cache session in Redis
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
    await redis.del(`session:${token}`);

    // Delete from correct shard
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