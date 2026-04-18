import express from 'express';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import photoRoutes from './routes/photos.js';

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