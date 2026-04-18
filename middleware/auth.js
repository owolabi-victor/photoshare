import { getShardForUser } from '../shardRouter.js';
import redis from '../redis.js';

const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Check Redis first
    const cachedSession = await redis.get(`session:${token}`);
    
    if (cachedSession) {
      req.user = JSON.parse(cachedSession);
      return next();
    }

    // Cache MISS - search all shards for the session
    const { getAllShards } = await import('../shardRouter.js');
    const allShards = getAllShards();
    let userData = null;

    for (const shard of allShards) {
      const [rows] = await shard.query(
        'SELECT sessions.*, users.username, users.email FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token = ?',
        [token]
      );
      if (rows.length > 0) {
        userData = {
          id: rows[0].user_id,
          username: rows[0].username,
          email: rows[0].email
        };
        break;
      }
    }

    if (!userData) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Cache in Redis for future requests
    await redis.set(`session:${token}`, JSON.stringify(userData), 'EX', 86400);

    req.user = userData;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

export default authenticate;