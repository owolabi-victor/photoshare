import mysql from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const masterPool = mysql.createPool({
  host: process.env.DB_MASTER_HOST,
  port: process.env.DB_MASTER_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const slavePool = mysql.createPool({
  host: process.env.DB_SLAVE_HOST,
  port: process.env.DB_SLAVE_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

export const masterDb = masterPool.promise();
export const slaveDb = slavePool.promise();