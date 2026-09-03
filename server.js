import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATABASE_URL = process.env.DATABASE_URL;

// Database connection pool
let pool;

if (!DATABASE_URL && NODE_ENV === 'production') {
  console.error('ERROR: DATABASE_URL environment variable is required in production');
  process.exit(1);
}

if (DATABASE_URL) {
  // Production: Use provided DATABASE_URL
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
} else {
  // Development: Use local PostgreSQL or fallback values
  pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'lakshmi_narayan',
  });
}

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ==================== HEALTH CHECK ====================
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      timestamp: result.rows[0].now,
      environment: NODE_ENV,
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({
      status: 'unhealthy',
      error: 'Database connection failed',
    });
  }
});

// ==================== DATABASE INITIALIZATION ====================
async function initializeDatabase() {
  try {
    console.log('Initializing database schema...');

    // Retail items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS retail_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        unit TEXT NOT NULL,
        purchase_rate NUMERIC(10, 2) NOT NULL,
        mrp NUMERIC(10, 2) NOT NULL,
        selling_price NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Wholesale items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wholesale_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        unit TEXT NOT NULL,
        purchase_rate NUMERIC(10, 2) NOT NULL,
        mrp NUMERIC(10, 2) NOT NULL,
        selling_price NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Retail bills table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS retail_bills (
        id SERIAL PRIMARY KEY,
        invoice_number TEXT UNIQUE NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        items JSONB NOT NULL,
        total NUMERIC(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Wholesale bills table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wholesale_bills (
        id SERIAL PRIMARY KEY,
        invoice_number TEXT UNIQUE NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        items JSONB NOT NULL,
        total NUMERIC(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_retail_items_name ON retail_items(name)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wholesale_items_name ON wholesale_items(name)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_retail_bills_invoice ON retail_bills(invoice_number)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wholesale_bills_invoice ON wholesale_bills(invoice_number)
    `);

    console.log('✅ Database schema initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing database:', err.message);
    throw err;
  }
}

// ==================== DATABASE HELPER FUNCTIONS ====================
const queryAsync = (query, params = []) => {
  return pool.query(query, params);
};

function parseMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isValidItemPayload({ name, unit, purchase_rate, mrp, selling_price } = {}) {
  return typeof name === 'string' && name.trim() !== '' &&
    typeof unit === 'string' && unit.trim() !== '' &&
    parseMoney(purchase_rate) !== null &&
    parseMoney(mrp) !== null &&
    parseMoney(selling_price) !== null;
}

function isValidBillPayload({ items, total } = {}) {
  return Array.isArray(items) && items.length > 0 &&
    parseMoney(total) !== null &&
    items.every(item => item && typeof item.name === 'string' &&
      Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 &&
      Number.isFinite(Number(item.rate)) && Number(item.rate) >= 0 &&
      Number.isFinite(Number(item.amount)) && Number(item.amount) >= 0);
}



// ==================== ADMIN PANEL ROUTES ====================

// Get all retail items
app.get('/api/retail-items', async (req, res) => {
  try {
    const result = await queryAsync('SELECT id, name, unit, purchase_rate, mrp, selling_price, created_at FROM retail_items ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching retail items:', err);
    res.status(500).json({ error: 'Failed to fetch retail items' });
  }
});

// Get all wholesale items
app.get('/api/wholesale-items', async (req, res) => {
  try {
    const result = await queryAsync('SELECT id, name, unit, purchase_rate, mrp, selling_price, created_at FROM wholesale_items ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching wholesale items:', err);
    res.status(500).json({ error: 'Failed to fetch wholesale items' });
  }
});

// Add retail item
app.post('/api/retail-items', async (req, res) => {
  try {
    const { name, unit, purchase_rate, mrp, selling_price } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'INSERT INTO retail_items (name, unit, purchase_rate, mrp, selling_price) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(purchase_rate), parseMoney(mrp), parseMoney(selling_price)]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Item already exists' });
    } else {
      console.error('Error creating retail item:', err);
      res.status(500).json({ error: 'Failed to create item' });
    }
  }
});

// Add wholesale item
app.post('/api/wholesale-items', async (req, res) => {
  try {
    const { name, unit, purchase_rate, mrp, selling_price } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'INSERT INTO wholesale_items (name, unit, purchase_rate, mrp, selling_price) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(purchase_rate), parseMoney(mrp), parseMoney(selling_price)]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Item already exists' });
    } else {
      console.error('Error creating wholesale item:', err);
      res.status(500).json({ error: 'Failed to create item' });
    }
  }
});

// Update retail item
app.put('/api/retail-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, unit, purchase_rate, mrp, selling_price } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'UPDATE retail_items SET name = $1, unit = $2, purchase_rate = $3, mrp = $4, selling_price = $5 WHERE id = $6 RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(purchase_rate), parseMoney(mrp), parseMoney(selling_price), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Item already exists' });
    } else {
      console.error('Error updating retail item:', err);
      res.status(500).json({ error: 'Failed to update item' });
    }
  }
});

// Update wholesale item
app.put('/api/wholesale-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, unit, purchase_rate, mrp, selling_price } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'UPDATE wholesale_items SET name = $1, unit = $2, purchase_rate = $3, mrp = $4, selling_price = $5 WHERE id = $6 RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(purchase_rate), parseMoney(mrp), parseMoney(selling_price), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Item already exists' });
    } else {
      console.error('Error updating wholesale item:', err);
      res.status(500).json({ error: 'Failed to update item' });
    }
  }
});

// Delete retail item
app.delete('/api/retail-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await queryAsync('DELETE FROM retail_items WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting retail item:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// Delete wholesale item
app.delete('/api/wholesale-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await queryAsync('DELETE FROM wholesale_items WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting wholesale item:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ==================== BILLING ROUTES ====================

// Generate retail bill
app.post('/api/retail-bills', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { items, total } = req.body;

    if (!isValidBillPayload(req.body)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid bill details' });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext('retail_bills_invoice'))");

    const now = new Date();
    const date = now.toLocaleDateString('en-IN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/');
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Get last invoice number
    const lastBillResult = await client.query('SELECT invoice_number FROM retail_bills ORDER BY id DESC LIMIT 1');
    let invoiceNumber = 'RB001';
    if (lastBillResult.rows.length > 0) {
      const lastNum = parseInt(lastBillResult.rows[0].invoice_number.substring(2));
      invoiceNumber = 'RB' + String(lastNum + 1).padStart(3, '0');
    }

    // Insert bill
    const result = await client.query(
      'INSERT INTO retail_bills (invoice_number, date, time, items, total) VALUES ($1, $2, $3, $4, $5) RETURNING id, invoice_number, date, time, items, total',
      [invoiceNumber, date, time, JSON.stringify(items), parseMoney(total)]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating retail bill:', err);
    res.status(500).json({ error: 'Failed to create bill' });
  } finally {
    client.release();
  }
});

// Generate wholesale bill
app.post('/api/wholesale-bills', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { items, total } = req.body;

    if (!isValidBillPayload(req.body)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid bill details' });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext('wholesale_bills_invoice'))");

    const now = new Date();
    const date = now.toLocaleDateString('en-IN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/');
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Get last invoice number
    const lastBillResult = await client.query('SELECT invoice_number FROM wholesale_bills ORDER BY id DESC LIMIT 1');
    let invoiceNumber = 'WB001';
    if (lastBillResult.rows.length > 0) {
      const lastNum = parseInt(lastBillResult.rows[0].invoice_number.substring(2));
      invoiceNumber = 'WB' + String(lastNum + 1).padStart(3, '0');
    }

    // Insert bill
    const result = await client.query(
      'INSERT INTO wholesale_bills (invoice_number, date, time, items, total) VALUES ($1, $2, $3, $4, $5) RETURNING id, invoice_number, date, time, items, total',
      [invoiceNumber, date, time, JSON.stringify(items), parseMoney(total)]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating wholesale bill:', err);
    res.status(500).json({ error: 'Failed to create bill' });
  } finally {
    client.release();
  }
});

// Get retail bills
app.get('/api/retail-bills', async (req, res) => {
  try {
    const result = await queryAsync('SELECT id, invoice_number, date, time, items, total, created_at FROM retail_bills ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching retail bills:', err);
    res.status(500).json({ error: 'Failed to fetch bills' });
  }
});

// Get wholesale bills
app.get('/api/wholesale-bills', async (req, res) => {
  try {
    const result = await queryAsync('SELECT id, invoice_number, date, time, items, total, created_at FROM wholesale_bills ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching wholesale bills:', err);
    res.status(500).json({ error: 'Failed to fetch bills' });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ==================== START SERVER ====================
async function startServer() {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');

    // Initialize database schema
    await initializeDatabase();

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n✨ Lakshmi Narayan Billing System`);
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${NODE_ENV}`);
      console.log(`🌍 URL: http://0.0.0.0:${PORT}\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
