// ─────────────────────────────────────────────────────────────
//  CS2 TRACKER — BACKEND Z POSTGRESQL + LOGOWANIEM + WATCHLISTĄ
// ─────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();

// 🔥 KLUCZOWA POPRAWKA DLA RAILWAY
const PORT = process.env.PORT || 3001;

// ───────────────── PostgreSQL ─────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET;

// ───────────────── Express ─────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────── JWT middleware ─────────────────
function createToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ───────────────── Helpers ─────────────────
function normalizeSteamPrice(str) {
  if (!str) return null;
  let cleaned = str.replace(/[^\d.,-]/g, '');
  cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

// ───────────────── Steam priceoverview ─────────────────
async function fetchSteamPrice(itemName) {
  const encoded = encodeURIComponent(itemName);
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=6&market_hash_name=${encoded}`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://steamcommunity.com/market/'
      },
      timeout: 12000
    });

    const d = response.data;
    if (!d.success) return null;

    return {
      lowest_price: normalizeSteamPrice(d.lowest_price),
      median_price: normalizeSteamPrice(d.median_price),
      volume: parseInt((d.volume || '0').replace(/[^\d]/g, '')) || 0,
      timestamp: Date.now()
    };
  } catch (e) {
    console.error(`Steam error for "${itemName}":`, e.message);
    return null;
  }
}

// ───────────────── AUTH: rejestracja ─────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'missing_fields' });

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash]
    );

    const token = createToken(result.rows[0].id);
    res.json({ token });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'email_exists' });
    }
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── AUTH: logowanie ─────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rowCount === 0)
      return res.status(400).json({ error: 'invalid_credentials' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) return res.status(400).json({ error: 'invalid_credentials' });

    const token = createToken(user.id);
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: pobieranie ─────────────────
app.get('/api/watchlist', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: dodawanie ─────────────────
app.post('/api/watchlist', auth, async (req, res) => {
  try {
    const { marketHashName, name, imageUrl } = req.body;

    const itemRes = await pool.query(
      `INSERT INTO items (market_hash, name, image_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (market_hash)
       DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
       RETURNING id`,
      [marketHashName, name, imageUrl]
    );

    const itemId = itemRes.rows[0].id;

    await pool.query(
      `INSERT INTO watchlist (user_id, item_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, item_id) DO NOTHING`,
      [req.userId, itemId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: usuwanie ─────────────────
app.delete('/api/watchlist/:itemId', auth, async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);

    await pool.query(
      'DELETE FROM watchlist WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── SEARCH (PLN) ─────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&appid=730&search_descriptions=0&sort_column=popular&sort_dir=desc&currency=6&count=10&format=json&norender=1`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://steamcommunity.com/market/',
        'Accept': 'application/json'
      },
      timeout: 12000
    });

    if (!response.data || !response.data.results) {
      return res.json([]);
    }

    const items = response.data.results.map(i => {
      const raw = i.sell_price_text || null;
      const numeric = normalizeSteamPrice(raw);

      return {
        name: i.name,
        marketHashName: i.hash_name,
        price: numeric,
        imageUrl: i.asset_description?.icon_url
          ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f`
          : null
      };
    });

    res.json(items);

  } catch (e) {
    console.error("Steam search error:", e.message);
    res.status(502).json({ error: 'Steam search failed' });
  }
});

// ───────────────── DB TEST ─────────────────
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: result.rows[0].now });
  } catch (e) {
    console.error('DB TEST ERROR:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ───────────────── HEALTH ─────────────────
app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// ───────────────── SPA fallback ─────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ───────────────── START ─────────────────
app.listen(PORT, () => {
  console.log(`CS2 Tracker running on port ${PORT}`);
});
