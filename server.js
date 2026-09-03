import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import pg from 'pg';
import PDFDocument from 'pdfkit';

const { Pool } = pg;

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
  // Development: use PostgreSQL settings supplied by the environment
  pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
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
app.use(bodyParser.json({ limit: '8mb' }));
app.use(express.static('public'));

// ==================== HEALTH CHECK ====================
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        shop_phone TEXT,
        shop_address TEXT,
        instagram_name TEXT,
        instagram_username TEXT,
        instagram_qr TEXT,
        logo_data TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('ALTER TABLE retail_bills ADD COLUMN IF NOT EXISTS customer_name TEXT');
    await pool.query('ALTER TABLE retail_bills ADD COLUMN IF NOT EXISTS customer_phone TEXT');
    await pool.query('ALTER TABLE retail_bills ADD COLUMN IF NOT EXISTS note TEXT');
    await pool.query('ALTER TABLE wholesale_bills ADD COLUMN IF NOT EXISTS customer_name TEXT');
    await pool.query('ALTER TABLE wholesale_bills ADD COLUMN IF NOT EXISTS customer_phone TEXT');
    await pool.query('ALTER TABLE wholesale_bills ADD COLUMN IF NOT EXISTS note TEXT');

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

function isValidItemPayload({ name, unit, mrp } = {}) {
  return typeof name === 'string' && name.trim() !== '' &&
    typeof unit === 'string' && unit.trim() !== '' &&
    parseMoney(mrp) !== null;
}

function isValidBillPayload({ items, total } = {}) {
  const parsedTotal = parseMoney(total);
  const itemTotal = Array.isArray(items) ? items.reduce((sum, item) => sum + Number(item?.amount), 0) : NaN;
  return Array.isArray(items) && items.length > 0 &&
    parsedTotal !== null && Number.isFinite(itemTotal) && Math.abs(parsedTotal - itemTotal) < 0.01 &&
    items.every(item => item && typeof item.name === 'string' && item.name.trim() !== '' &&
      Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 &&
      Number.isFinite(Number(item.rate)) && Number(item.rate) >= 0 &&
      Number.isFinite(Number(item.amount)) && Number(item.amount) >= 0);
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}



// ==================== ADMIN PANEL ROUTES ====================

// Get all retail items
app.get('/api/retail-items', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const result = await queryAsync('SELECT id, name, unit, purchase_rate, mrp, selling_price, created_at FROM retail_items WHERE name ILIKE $1 ORDER BY name', [`%${search}%`]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching retail items:', err);
    res.status(500).json({ error: 'Failed to fetch retail items' });
  }
});

// Get all wholesale items
app.get('/api/wholesale-items', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const result = await queryAsync('SELECT id, name, unit, purchase_rate, mrp, selling_price, created_at FROM wholesale_items WHERE name ILIKE $1 ORDER BY name', [`%${search}%`]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching wholesale items:', err);
    res.status(500).json({ error: 'Failed to fetch wholesale items' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await queryAsync('SELECT shop_phone, shop_address, instagram_name, instagram_username, instagram_qr, logo_data FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const allowed = ['shop_phone', 'shop_address', 'instagram_name', 'instagram_username', 'instagram_qr', 'logo_data'];
    const values = allowed.map(key => typeof req.body[key] === 'string' ? req.body[key].trim() : '');
    const result = await queryAsync(`
      INSERT INTO settings (id, ${allowed.join(', ')}, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET ${allowed.map((key, index) => `${key} = $${index + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
      RETURNING shop_phone, shop_address, instagram_name, instagram_username, instagram_qr, logo_data
    `, values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Add retail item
app.post('/api/retail-items', async (req, res) => {
  try {
    const { name, unit, mrp } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'INSERT INTO retail_items (name, unit, purchase_rate, mrp, selling_price) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(mrp), parseMoney(mrp), parseMoney(mrp)]
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
    const { name, unit, mrp } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await queryAsync(
      'INSERT INTO wholesale_items (name, unit, purchase_rate, mrp, selling_price) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(mrp), parseMoney(mrp), parseMoney(mrp)]
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
    const { name, unit, mrp } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (parseId(id) === null) {
      return res.status(400).json({ error: 'Invalid item id' });
    }

    const result = await queryAsync(
      'UPDATE retail_items SET name = $1, unit = $2, purchase_rate = $3, mrp = $4, selling_price = $5 WHERE id = $6 RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(mrp), parseMoney(mrp), parseMoney(mrp), id]
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
    const { name, unit, mrp } = req.body;

    if (!isValidItemPayload(req.body)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (parseId(id) === null) {
      return res.status(400).json({ error: 'Invalid item id' });
    }

    const result = await queryAsync(
      'UPDATE wholesale_items SET name = $1, unit = $2, purchase_rate = $3, mrp = $4, selling_price = $5 WHERE id = $6 RETURNING id, name, unit, purchase_rate, mrp, selling_price',
      [name.trim(), unit.trim(), parseMoney(mrp), parseMoney(mrp), parseMoney(mrp), id]
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
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid item id' });
    const result = await queryAsync('DELETE FROM retail_items WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting retail item:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// Delete wholesale item
app.delete('/api/wholesale-items/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid item id' });
    const result = await queryAsync('DELETE FROM wholesale_items WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
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

    const { items, total, customer_name, customer_phone, note } = req.body;

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
      'INSERT INTO retail_bills (invoice_number, date, time, items, total, customer_name, customer_phone, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, invoice_number, date, time, items, total, customer_name, customer_phone, note',
      [invoiceNumber, date, time, JSON.stringify(items), parseMoney(total), customer_name || null, customer_phone || null, note || null]
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

    const { items, total, customer_name, customer_phone, note } = req.body;

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
      'INSERT INTO wholesale_bills (invoice_number, date, time, items, total, customer_name, customer_phone, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, invoice_number, date, time, items, total, customer_name, customer_phone, note',
      [invoiceNumber, date, time, JSON.stringify(items), parseMoney(total), customer_name || null, customer_phone || null, note || null]
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

function safeText(value) {
  return String(value || '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
}

app.post('/api/exports/pdf', async (req, res) => {
  try {
    const { receiptImage, receiptWidth, receiptHeight } = req.body;
    if (typeof receiptImage !== 'string' || !receiptImage.startsWith('data:image/png;base64,') || !Number.isFinite(Number(receiptWidth)) || !Number.isFinite(Number(receiptHeight))) {
      return res.status(400).json({ error: 'Invalid receipt image' });
    }
    const pdfWidth = 226.77;
    const pdfHeight = pdfWidth * Number(receiptHeight) / Number(receiptWidth);
    const doc = new PDFDocument({ size: [pdfWidth, pdfHeight], margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const filename = `LAXMI-NARAYAN-NAMKEEN-ESTIMATE-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.pdf`;
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` }).send(Buffer.concat(chunks));
    });
    doc.image(Buffer.from(receiptImage.slice('data:image/png;base64,'.length), 'base64'), 0, 0, { width: pdfWidth, height: pdfHeight });
    doc.end();
  } catch (err) { console.error('PDF export failed:', err); res.status(500).json({ error: 'Failed to create PDF' }); }
});

app.post('/api/exports/png', async (req, res) => {
  try {
    const { receiptImage } = req.body;
    if (typeof receiptImage !== 'string' || !receiptImage.startsWith('data:image/png;base64,')) return res.status(400).json({ error: 'Invalid receipt image' });
    const png = Buffer.from(receiptImage.slice('data:image/png;base64,'.length), 'base64');
    const filename = `LAXMI-NARAYAN-NAMKEEN-ESTIMATE-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.png`;
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${filename}"` }).send(png);
  } catch (err) { console.error('PNG export failed:', err); res.status(500).json({ error: 'Failed to create PNG' }); }
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
    console.error('❌ Failed to start server:', err.message || err);
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
