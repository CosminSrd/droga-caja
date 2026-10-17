import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 300,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (error) => console.error('PostgreSQL idle client error:', error));
