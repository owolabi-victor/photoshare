import mysql from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const NUM_SHARDS = 2;

// Create a pool for each shard
const shards = [
  // Shard 0
  mysql.createPool({
    host: process.env.DB_SHARD0_HOST,
    port: process.env.DB_SHARD0_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }).promise(),

  // Shard 1
  mysql.createPool({
    host: process.env.DB_SHARD1_HOST,
    port: process.env.DB_SHARD1_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }).promise(),
];

// Route to correct shard based on user_id
export function getShardForUser(userId) {
  const shardIndex = userId % NUM_SHARDS;
  return shards[shardIndex];
}

// Get all shards for global queries
export function getAllShards() {
  return shards;
}

export default shards;