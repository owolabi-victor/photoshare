import { slaveDb } from '../db.js';
import redis from '../redis.js';

const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];

  if (!token) {
    return res.status(401).json({ error:'No token provided' });
  }

  try {
    // Check Redis first
    const cachedSession = await redis.get(`session:${token}`);
    
    if (cachedSession) {
      req.user = JSON.parse(cachedSession);
      return next();
    }

    // Cache MISS - check database
    const [rows] = await slaveDb.query(
      'SELECT sessions.*, users.username, users.email FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token = ?',
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = {
      id: rows[0].user_id,
      username: rows[0].username,
      email: rows[0].email
    };

    // Store in Redis for future requests with 24 hour TTL
    await redis.set(`session:${token}`, JSON.stringify(user), 'EX', 86400);

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

export default authenticate;