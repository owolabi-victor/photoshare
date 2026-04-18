import express from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { masterDb, slaveDb } from '../db.js';
import redis from '../redis.js';
import authenticate from '../middleware/auth.js';

const router = express.Router();

// REGISTER
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, 10);

    await masterDb.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, password_hash]
    );

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error('Register error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
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

    // Read → slave
    const [rows] = await slaveDb.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (rows.length === 0) {
      // Increment failed attempts
      await redis.incr(rateLimitKey);
      await redis.expire(rateLimitKey, 900);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      // Increment failed attempts
      await redis.incr(rateLimitKey);
      await redis.expire(rateLimitKey, 900);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset rate limit on successful login
    await redis.del(rateLimitKey);

    const token = uuidv4();

    // Write → master
    await masterDb.query(
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
      user: sessionData
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
    // Delete from Redis immediately
    await redis.del(`session:${token}`);

    // Delete from database
    await masterDb.query(
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