import express from 'express';
import multer from 'multer';
import path from 'path';
import { masterDb, slaveDb } from '../db.js';
import authenticate from '../middleware/auth.js';

const router = express.Router();

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

    // Write → master
    await masterDb.query(
      'INSERT INTO photos (user_id, filename, caption) VALUES (?, ?, ?)',
      [req.user.id, req.file.filename, caption || null]
    );

    res.status(201).json({ 
      message: 'Photo uploaded successfully',
      photo: {
        filename: req.file.filename,
        caption: caption || null,
        url: `http://localhost:${process.env.PORT}/uploads/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET ALL PHOTOS (feed)
router.get('/feed', authenticate, async (req, res) => {
  try {
    // Read → slave
    const [rows] = await slaveDb.query(
      `SELECT photos.id, photos.filename, photos.caption, photos.created_at,
              users.username
       FROM photos 
       JOIN users ON photos.user_id = users.id
       ORDER BY photos.created_at DESC`
    );

    const photos = rows.map(photo => ({
      id: photo.id,
      username: photo.username,
      caption: photo.caption,
      created_at: photo.created_at,
      url: `http://localhost:${process.env.PORT}/uploads/${photo.filename}`
    }));

    res.status(200).json({ photos });
  } catch (error) {
    console.error('Feed error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET MY PHOTOS
router.get('/my-photos', authenticate, async (req, res) => {
  try {
    // Read → slave
    const [rows] = await slaveDb.query(
      'SELECT * FROM photos WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );

    const photos = rows.map(photo => ({
      id: photo.id,
      caption: photo.caption,
      created_at: photo.created_at,
      url: `http://localhost:${process.env.PORT}/uploads/${photo.filename}`
    }));

    res.status(200).json({ photos });
  } catch (error) {
    console.error('My photos error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;