import { slaveDb } from '../db.js';

const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Read → slave
    const [rows] = await slaveDb.query(
      'SELECT sessions.*, users.username, users.email FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token = ?',
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: rows[0].user_id,
      username: rows[0].username,
      email: rows[0].email
    };

    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

export default authenticate;