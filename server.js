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
const PORT = process.env.PORT || 3001;

// ───────────────── PostgreSQL ─────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ───────────────── Express ─────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────── DB Init ─────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      market_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      image_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      buy_price NUMERIC(10,2),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS prices (
      id SERIAL PRIMARY KEY,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      lowest_price NUMERIC(10,2),
      median_price NUMERIC(10,2),
      volume INTEGER,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB schema OK');
}

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
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ───────────────── Helpers ─────────────────
function normalizeSteamPrice(str) {
  if (!str) return null;
  // Usuń wszystko poza cyframi, przecinkiem i kropką
  let cleaned = str.replace(/[^\d.,]/g, '');
  // Format PLN: "5,38" lub "1 453,00" (spacja jako separator tysięcy)
  // Format USD: "1.44" lub "1,444.00"
  // Wykryj format po tym czy przecinek czy kropka jest ostatnim separatorem
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Przecinek jest separatorem dziesiętnym (format EU/PLN): "1 453,00" → "1453.00"
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Kropka jest separatorem dziesiętnym (format US): "1,444.00" → "1444.00"
    cleaned = cleaned.replace(/,/g, '');
  }
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

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
      volume: parseInt((d.volume || '0').replace(/[^\d]/g, '')) || 0
    };
  } catch (e) {
    console.error(`Steam error for "${itemName}":`, e.message);
    return null;
  }
}

// Buduje pełny obiekt watchlist item (z ceną) do wysłania na frontend
async function getWatchlistItem(watchlistId, userId) {
  const result = await pool.query(
    `SELECT
       w.id,
       i.name,
       i.market_hash,
       i.image_url AS "imageUrl",
       w.buy_price AS "buyPrice",
       p.lowest_price AS "currentPrice",
       p.median_price AS "currentMedian",
       p.volume AS "currentVolume",
       EXTRACT(EPOCH FROM p.fetched_at) * 1000 AS "lastUpdated"
     FROM watchlist w
     JOIN items i ON i.id = w.item_id
     LEFT JOIN prices p ON p.item_id = w.item_id
       AND p.fetched_at = (SELECT MAX(fetched_at) FROM prices WHERE item_id = w.item_id)
     WHERE w.id = $1 AND w.user_id = $2`,
    [watchlistId, userId]
  );
  return result.rows[0] || null;
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
    if (e.code === '23505')
      return res.status(400).json({ error: 'email_exists' });
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
      `SELECT
         w.id,
         i.name,
         i.market_hash,
         i.image_url AS "imageUrl",
         w.buy_price AS "buyPrice",
         p.lowest_price AS "currentPrice",
         p.median_price AS "currentMedian",
         p.volume AS "currentVolume",
         EXTRACT(EPOCH FROM p.fetched_at) * 1000 AS "lastUpdated"
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       LEFT JOIN prices p ON p.item_id = w.item_id
         AND p.fetched_at = (SELECT MAX(fetched_at) FROM prices WHERE item_id = w.item_id)
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
    const { marketHashName, name, imageUrl, buyPrice } = req.body;
    if (!marketHashName || !name)
      return res.status(400).json({ error: 'missing_fields' });

    // Upsert item
    const itemRes = await pool.query(
      `INSERT INTO items (market_hash, name, image_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (market_hash)
       DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
       RETURNING id`,
      [marketHashName, name, imageUrl || null]
    );
    const itemId = itemRes.rows[0].id;

    // Sprawdź czy już na watchliście
    const existing = await pool.query(
      'SELECT id FROM watchlist WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );
    if (existing.rowCount > 0)
      return res.status(409).json({ error: 'already_exists' });

    // Dodaj do watchlisty
    const wRes = await pool.query(
      `INSERT INTO watchlist (user_id, item_id, buy_price)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [req.userId, itemId, buyPrice || null]
    );
    const watchlistId = wRes.rows[0].id;

    // Od razu pobierz cenę ze Steam
    const price = await fetchSteamPrice(marketHashName);
    if (price) {
      await pool.query(
        `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [itemId, price.lowest_price, price.median_price, price.volume]
      );
    }

    // Zwróć pełny obiekt (z w.id jako id — ważne dla selectItem!)
    const item = await getWatchlistItem(watchlistId, req.userId);
    res.json(item || { id: watchlistId, name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: usuwanie ─────────────────
app.delete('/api/watchlist/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: aktualizacja buy_price ─────────────────
app.patch('/api/watchlist/:id', auth, async (req, res) => {
  try {
    const { buyPrice } = req.body;
    await pool.query(
      'UPDATE watchlist SET buy_price = $1 WHERE id = $2 AND user_id = $3',
      [buyPrice || null, req.params.id, req.userId]
    );
    const item = await getWatchlistItem(req.params.id, req.userId);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── HISTORY ─────────────────
app.get('/api/history/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM p.fetched_at) * 1000 AS ts,
         p.lowest_price AS lowest,
         p.median_price AS median
       FROM prices p
       JOIN watchlist w ON w.item_id = p.item_id
       WHERE w.id = $1 AND w.user_id = $2
       ORDER BY p.fetched_at ASC`,
      [req.params.id, req.userId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── REFRESH: pojedynczy item ─────────────────
app.post('/api/refresh/:id', auth, async (req, res) => {
  try {
    // Pobierz market_hash powiązany z watchlist row
    const itemRes = await pool.query(
      `SELECT i.id, i.market_hash
       FROM items i
       JOIN watchlist w ON w.item_id = i.id
       WHERE w.id = $1 AND w.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!itemRes.rowCount)
      return res.status(404).json({ error: 'not_found' });

    const { id: itemId, market_hash } = itemRes.rows[0];

    const price = await fetchSteamPrice(market_hash);
    if (!price) return res.status(502).json({ error: 'steam_error' });

    await pool.query(
      `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [itemId, price.lowest_price, price.median_price, price.volume]
    );

    const item = await getWatchlistItem(req.params.id, req.userId);
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── REFRESH: wszystkie itemy usera ─────────────────
app.post('/api/refresh-all', auth, async (req, res) => {
  // Odpowiedz od razu, odświeżaj w tle
  res.json({ ok: true });

  try {
    const result = await pool.query(
      `SELECT i.id, i.market_hash
       FROM items i
       JOIN watchlist w ON w.item_id = i.id
       WHERE w.user_id = $1`,
      [req.userId]
    );

    for (const item of result.rows) {
      await new Promise(r => setTimeout(r, 3000)); // respektuj Steam rate limit
      const price = await fetchSteamPrice(item.market_hash);
      if (price) {
        await pool.query(
          `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [item.id, price.lowest_price, price.median_price, price.volume]
        );
      }
    }
    console.log(`refresh-all done for user ${req.userId}`);
  } catch (e) {
    console.error('refresh-all error:', e.message);
  }
});

// ───────────────── SEARCH ─────────────────
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

    if (!response.data?.results) return res.json([]);

    const raw = response.data.results.slice(0, 10);

    // Pobierz ceny PLN z priceoverview dla pierwszych 6 wyników równolegle
    const pricePromises = raw.slice(0, 6).map(i =>
      fetchSteamPrice(i.hash_name).catch(() => null)
    );
    const prices = await Promise.all(pricePromises);

    const items = raw.map((i, idx) => ({
      name: i.name,
      marketHashName: i.hash_name,
      price: prices[idx]?.lowest_price ?? null,  // PLN z priceoverview
      imageUrl: i.asset_description?.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f`
        : null
    }));

    res.json(items);
  } catch (e) {
    console.error('Steam search error:', e.message);
    res.status(502).json({ error: 'steam_search_failed' });
  }
});

// ───────────────── AUTO REFRESH (co godzinę, wszystkie itemy) ─────────────────
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Auto-refresh start');
  try {
    const result = await pool.query('SELECT id, market_hash FROM items');
    for (const item of result.rows) {
      await new Promise(r => setTimeout(r, 3000));
      const price = await fetchSteamPrice(item.market_hash);
      if (price) {
        await pool.query(
          `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [item.id, price.lowest_price, price.median_price, price.volume]
        );
      }
    }
    console.log('[cron] Auto-refresh done');
  } catch (e) {
    console.error('[cron] error:', e.message);
  }
});

// ───────────────── HEALTH / DB TEST ─────────────────
app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: result.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ───────────────── SPA fallback ─────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ───────────────── START ─────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CS2 Tracker running on port ${PORT}`);
    });
  })
  .catch(e => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  });
