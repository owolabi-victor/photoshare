import express from 'express';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/auth', authRoutes);
app.use('/photos', photoRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Photoshare API is running',
    instance: process.env.PORT
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});