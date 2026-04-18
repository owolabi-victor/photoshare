import amqplib from 'amqplib';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const QUEUE_NAME = 'photo_processing';
const UPLOADS_DIR = '/app/uploads';

async function processPhoto(job) {
  const { filename } = job;
  const inputPath = path.join(UPLOADS_DIR, filename);
  const extension = path.extname(filename);
  const baseName = path.basename(filename, extension);

  console.log(`Processing photo: ${filename}`);

  // Generate thumbnail (200x200)
  const thumbnailPath = path.join(UPLOADS_DIR, `${baseName}-thumbnail${extension}`);
  await sharp(inputPath)
    .resize(200, 200, { fit: 'cover' })
    .toFile(thumbnailPath);

  // Generate medium (800x800)
  const mediumPath = path.join(UPLOADS_DIR, `${baseName}-medium${extension}`);
  await sharp(inputPath)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .toFile(mediumPath);

  console.log(`Done processing: ${filename}`);
  console.log(`  Thumbnail: ${baseName}-thumbnail${extension}`);
  console.log(`  Medium: ${baseName}-medium${extension}`);
}

async function startWorker() {
  let connection;
  let retries = 10;

  // Retry connection - RabbitMQ takes time to start
  while (retries > 0) {
    try {
      connection = await amqplib.connect(process.env.RABBITMQ_URL);
      console.log('Worker connected to RabbitMQ');
      break;
    } catch (error) {
      retries--;
      console.log(`RabbitMQ not ready, retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (!connection) {
    console.error('Could not connect to RabbitMQ after multiple attempts');
    process.exit(1);
  }

  const channel = await connection.createChannel();

  // Declare queue - creates it if it doesn't exist
  await channel.assertQueue(QUEUE_NAME, { durable: true });

  // Only process one job at a time
  channel.prefetch(1);

  console.log(`Worker waiting for jobs in queue: ${QUEUE_NAME}`);

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;

    const job = JSON.parse(msg.content.toString());
    console.log('Received job:', job);

    try {
      await processPhoto(job);
      // Acknowledge job completed successfully
      channel.ack(msg);
    } catch (error) {
      console.error('Job failed:', error);
      // Reject job and requeue it
      channel.nack(msg, false, true);
    }
  });

  // Handle connection errors
  connection.on('error', (err) => {
    console.error('RabbitMQ connection error:', err);
    process.exit(1);
  });
}

startWorker();