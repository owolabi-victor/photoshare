import express from 'express';
import multer from 'multer';
import path from 'path';
import amqplib from 'amqplib';
import { getShardForUser, getAllShards } from '../shardRouter.js';
import authenticate from '../middleware/auth.js';
import redis from '../redis.js';

const router = express.Router();

let channel;
async function getChannel() {
  if (channel) return channel;
  try {
    const connection = await amqplib.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue('photo_processing', { durable: true });
    console.log('Connected to RabbitMQ');
    return channel;
  } catch (error) {
    console.error('RabbitMQ connection failed:', error.message);
    return null;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

const upload = multer({ 
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// UPLOAD PHOTO
router.post('/upload', authenticate, upload.single('photo'), async (req, res) => {
  const { caption } = req.body;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Write to correct shard based on user_id
    const shard = getShardForUser(req.user.id);
    await shard.query(
      'INSERT INTO photos (user_id, filename, caption) VALUES (?, ?, ?)',
      [req.user.id, req.file.filename, caption || null]
    );

    // Invalidate cache
    await redis.del('feed');
    await redis.del(`user:${req.user.id}:photos`);

    // Publish job to RabbitMQ
    const ch = await getChannel();
    if (ch) {
      const job = { filename: req.file.filename };
      ch.sendToQueue(
        'photo_processing',
        Buffer.from(JSON.stringify(job)),
        { persistent: true }
      );
      console.log('Job published to queue:', job);
    }

    res.status(201).json({ 
      message: 'Photo uploaded successfully. Processing in background.',
      photo: {
        filename: req.file.filename,
        caption: caption || null,
        url: `http://localhost/uploads/${req.file.filename}`,
        shard: req.user.id % 2
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET ALL PHOTOS (feed) - queries all shards
router.get('/feed', authenticate, async (req, res) => {
  try {
    const cached = await redis.get('feed');
    if (cached) {
      return res.status(200).json({ 
        photos: JSON.parse(cached),
        source: 'cache'
      });
    }

    // Fan-out query across all shards
    const allShards = getAllShards();
    const shardResults = await Promise.all(
      allShards.map(shard => shard.query(
        `SELECT photos.id, photos.filename, photos.caption, photos.created_at,
                users.username
         FROM photos 
         JOIN users ON photos.user_id = users.id
         ORDER BY photos.created_at DESC
         LIMIT 100`
      ))
    );

    // Merge and sort results from all shards
    const allPhotos = shardResults
      .flatMap(([rows]) => rows)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100)
      .map(photo => ({
        id: photo.id,
        username: photo.username,
        caption: photo.caption,
        created_at: photo.created_at,
        url: `http://localhost/uploads/${photo.filename}`,
        thumbnail_url: `http://localhost/uploads/${path.basename(photo.filename, path.extname(photo.filename))}-thumbnail${path.extname(photo.filename)}`,
        medium_url: `http://localhost/uploads/${path.basename(photo.filename, path.extname(photo.filename))}-medium${path.extname(photo.filename)}`
      }));

    await redis.set('feed', JSON.stringify(allPhotos), 'EX', 30);
    res.status(200).json({ photos: allPhotos, source: 'database' });
  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET MY PHOTOS - single shard query
router.get('/my-photos', authenticate, async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:photos`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json({ 
        photos: JSON.parse(cached),
        source: 'cache'
      });
    }

    // Read from correct shard only
    const shard = getShardForUser(req.user.id);
    const [rows] = await shard.query(
      'SELECT * FROM photos WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );

    const photos = rows.map(photo => ({
      id: photo.id,
      caption: photo.caption,
      created_at: photo.created_at,
      url: `http://localhost/uploads/${photo.filename}`,
      thumbnail_url: `http://localhost/uploads/${path.basename(photo.filename, path.extname(photo.filename))}-thumbnail${path.extname(photo.filename)}`,
      medium_url: `http://localhost/uploads/${path.basename(photo.filename, path.extname(photo.filename))}-medium${path.extname(photo.filename)}`
    }));

    await redis.set(cacheKey, JSON.stringify(photos), 'EX', 30);
    res.status(200).json({ photos, source: 'database' });
  } catch (error) {
    console.error('My photos error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;