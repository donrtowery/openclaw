import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'openclaw_db',
  user: process.env.DB_USER || 'openclaw',
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
  process.exit(-1);
});

/**
 * Execute a query
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms): ${text.substring(0, 100)}`);
    }

    return result;
  } catch (error) {
    console.error('[DB] Query error:', error.message);
    console.error('[DB] Query:', text);
    throw error;
  }
}

/**
 * Get a client from the pool (for transactions)
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Test database connection
 */
export async function testConnection() {
  try {
    const result = await query('SELECT NOW() as now, COUNT(*) as symbols FROM symbols');
    const now = result.rows[0].now;
    const symbolCount = result.rows[0].symbols;

    console.log(`[DB] Connected: ${now}`);
    console.log(`[DB] Symbols loaded: ${symbolCount}`);

    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    return false;
  }
}

export default pool;
