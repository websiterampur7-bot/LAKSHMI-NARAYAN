import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import * as fontkit from 'fontkit';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logoPath = path.join(__dirname, 'public', 'assets', 'logo.png');

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
app.use(bodyParser.json({ limit: '1mb' }));
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

async function getExportSettings() {
  const result = await queryAsync('SELECT shop_phone, shop_address, instagram_name, instagram_username, instagram_qr, logo_data FROM settings WHERE id = 1');
  return result.rows[0] || {};
}

function exportRows(bill, settings) {
  return (bill.items || []).map(item => ({
    name: safeText(item.name), quantity: item.quantity, unit: safeText(item.packaging || item.unit), rate: Number(item.rate || item.mrp || 0), amount: Number(item.amount || 0),
  }));
}

function xmlText(value) {
  return String(value || '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
}

function exportDetails(bill) {
  const storedNote = String(bill.note || '');
  const description = String(bill.description || (storedNote.match(/^Description: (.*)$/m) || [])[1] || '');
  const note = String(bill.note && storedNote.replace(/^Description: .*\n?/, '').replace(/^Note: /, '') || '');
  return { description, note };
}

function containsDevanagari(value) {
  return /[\u0900-\u097F]/.test(String(value || ''));
}

function pdfFont(doc, value, brand = false) {
  const brandFontPath = 'C:\\Windows\\Fonts\\BOD_R.TTF';
  const bodyFontPath = 'C:\\Windows\\Fonts\\cour.ttf';
  const devanagariFontPath = 'C:\\Windows\\Fonts\\Nirmala.ttc';
  if (brand && fs.existsSync(brandFontPath)) {
    doc.font(brandFontPath);
  } else if (!brand && containsDevanagari(value) && fs.existsSync(devanagariFontPath)) {
    const devanagariFont = fontkit.openSync(devanagariFontPath).fonts.find(font => font.familyName === 'Nirmala UI' && font.subfamilyName === 'Regular');
    if (devanagariFont) doc.font(devanagariFont);
  } else if (fs.existsSync(bodyFontPath)) {
    doc.font(bodyFontPath);
  }
}

function logoData(settings) {
  if (settings.logo_data) return settings.logo_data;
  if (fs.existsSync(logoPath)) return `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
  return '';
}

app.post('/api/exports/pdf', async (req, res) => {
  try {
    const { bill, type } = req.body;
    const settings = await getExportSettings();
    const rows = exportRows(bill, settings);
    const details = exportDetails(bill);
    const receiptWidth = 226.77;
    const receiptHeight = Math.max(320, 260 + rows.length * 42 + (details.description ? 14 : 0) + (details.note ? 14 : 0));
    const doc = new PDFDocument({ size: [receiptWidth, receiptHeight], margin: 18 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const filename = `LAXMI-NARAYAN-NAMKEEN-ESTIMATE-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.pdf`;
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` }).send(Buffer.concat(chunks));
    });
    const innerWidth = receiptWidth - 36;
    const imageData = logoData(settings);
    if (imageData) doc.image(Buffer.from(imageData.split(',')[1], 'base64'), { fit: [180, 78], align: 'center' });
    pdfFont(doc, 'LAXMI NARAYAN', true);
    doc.fontSize(12).text('LAXMI NARAYAN', { align: 'center' });
    doc.text('NAMKEEN', { align: 'center' });
    pdfFont(doc, 'ESTIMATE');
    doc.fontSize(9).text('ESTIMATE', { align: 'center' }).moveDown(0.5);
    doc.fontSize(8).text(`${type === 'wholesale' ? 'WHOLESALE' : 'RETAIL'}  ${bill.invoice_number || ''}`, { align: 'center' });
    doc.text(`${bill.date || ''} | ${bill.time || ''}`, { align: 'center' }).moveDown(0.8);
    rows.forEach(row => {
      pdfFont(doc, row.name);
      const rowTop = doc.y;
      doc.fontSize(8).text(`${row.name}\n${row.quantity} ${row.unit}`, 18, rowTop, { width: innerWidth * 0.48 });
      doc.text(`₹ ${row.rate.toFixed(2)}`, 18 + innerWidth * 0.48, rowTop, { width: innerWidth * 0.24, align: 'right' });
      doc.text(`₹ ${row.amount.toFixed(2)}`, 18 + innerWidth * 0.72, rowTop, { width: innerWidth * 0.28, align: 'right' });
      doc.y = rowTop + 28;
    });
    doc.moveDown(0.4).fontSize(11).text(`TOTAL: ₹ ${Number(bill.total).toFixed(2)}`, { align: 'right' });
    if (bill.customer_name) doc.fontSize(8).text(`Customer: ${safeText(bill.customer_name)}`);
    if (bill.customer_phone) doc.text(`Phone: ${safeText(bill.customer_phone)}`);
    if (details.description) doc.text(`Description: ${safeText(details.description)}`);
    if (details.note) doc.text(`Note: ${safeText(details.note)}`);
    doc.end();
  } catch (err) { console.error('PDF export failed:', err); res.status(500).json({ error: 'Failed to create PDF' }); }
});

app.post('/api/exports/png', async (req, res) => {
  try {
    const { bill, type } = req.body;
    const settings = await getExportSettings();
    const rows = exportRows(bill, settings);
    const details = exportDetails(bill);
    const scale = 3;
    const width = 302;
    const rowHeight = 28;
    const height = Math.max(420, 340 + rows.length * rowHeight + (details.description ? 24 : 0) + (details.note ? 24 : 0));
    const image = logoData(settings);
    let y = 28;
    const text = (value, className, x, textY, size, anchor = 'start') => `<text class="${className}" x="${x}" y="${textY}" font-size="${size}" text-anchor="${anchor}">${xmlText(value)}</text>`;
    let content = `<rect width="100%" height="100%" fill="white"/>`;
    if (image) { content += `<image href="${image}" x="${(width - 180) / 2}" y="${y}" width="180" height="78" preserveAspectRatio="xMidYMid meet"/>`; y += 88; }
    content += text('LAXMI NARAYAN', 'brand', width / 2, y, 16, 'middle') + text('NAMKEEN', 'brand', width / 2, y + 20, 16, 'middle'); y += 45;
    content += text('ESTIMATE', 'body center', width / 2, y, 13, 'middle'); y += 24;
    content += text(`${type === 'wholesale' ? 'WHOLESALE' : 'RETAIL'}  ${bill.invoice_number || ''}`, 'body center', width / 2, y, 10, 'middle'); y += 16;
    content += text(`${bill.date || ''} | ${bill.time || ''}`, 'body center', width / 2, y, 10, 'middle'); y += 24;
    rows.forEach(row => { content += text(row.name, containsDevanagari(row.name) ? 'dev body' : 'body', 18, y, 10); content += text(`${row.quantity} ${row.unit}`, containsDevanagari(row.name) ? 'dev body' : 'body', 18, y + 13, 9); content += text(`₹ ${row.rate.toFixed(2)}`, 'body', 220, y, 10, 'end'); content += text(`₹ ${row.amount.toFixed(2)}`, 'body', width - 18, y, 10, 'end'); y += rowHeight; });
    content += text(`TOTAL: ₹ ${Number(bill.total).toFixed(2)}`, 'body bold', width - 18, y + 4, 14, 'end'); y += 32;
    if (bill.customer_name) { content += text(`Customer: ${bill.customer_name}`, 'body', 18, y, 10); y += 18; }
    if (bill.customer_phone) { content += text(`Phone: ${bill.customer_phone}`, 'body', 18, y, 10); y += 18; }
    if (details.description) { content += text(`Description: ${details.description}`, 'body', 18, y, 10); y += 18; }
    if (details.note) { content += text(`Note: ${details.note}`, 'body', 18, y, 10); y += 18; }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.max(height, y + 32)}"><style>.brand{font-family:'Bodoni MT','Baskerville Old Face',Georgia,serif;fill:#111}.body{font-family:'Courier New','Nirmala UI',sans-serif;fill:#111}.dev{font-family:'Nirmala UI','Nirmala',sans-serif}.bold{font-weight:700}.center{text-anchor:middle}</style>${content}</svg>`;
    const png = await sharp(Buffer.from(svg)).resize({ width: width * scale, height: Math.max(height, y + 32) * scale }).png().toBuffer();
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
