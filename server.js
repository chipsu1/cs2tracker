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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      watchlist_id INTEGER REFERENCES watchlist(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      buy_price NUMERIC(10,2) NOT NULL,
      bought_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT
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

  // Migracja: jeśli stara kolumna buy_price istnieje w watchlist, przenieś dane
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='watchlist' AND column_name='buy_price'
    `);
    if (col.rowCount > 0) {
      await pool.query(`
        INSERT INTO purchases (watchlist_id, quantity, buy_price)
        SELECT id, 1, buy_price FROM watchlist
        WHERE buy_price IS NOT NULL
        ON CONFLICT DO NOTHING;
        ALTER TABLE watchlist DROP COLUMN IF EXISTS buy_price;
      `);
      console.log('Migracja buy_price OK');
    }
  } catch (e) {
    console.warn('Migracja pominięta:', e.message);
  }

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
  let cleaned = str.replace(/[^\d.,]/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma > lastDot) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
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

// Buduje pełny obiekt watchlist item z cenami i zakupami
async function getWatchlistItem(watchlistId, userId) {
  const result = await pool.query(
    `SELECT
       w.id,
       i.name,
       i.market_hash,
       i.image_url AS "imageUrl",
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
  if (!result.rowCount) return null;

  const item = result.rows[0];
  const purch = await pool.query(
    `SELECT id, quantity, buy_price AS "buyPrice",
            bought_at AS "boughtAt", note
     FROM purchases WHERE watchlist_id = $1
     ORDER BY bought_at ASC`,
    [watchlistId]
  );

  const purchases = purch.rows;
  const totalQty = purchases.reduce((s, p) => s + Number(p.quantity), 0);
  const totalSpent = purchases.reduce((s, p) => s + Number(p.quantity) * parseFloat(p.buyPrice), 0);
  const avgBuyPrice = totalQty > 0 ? totalSpent / totalQty : null;
  const currentPrice = item.currentPrice ? parseFloat(item.currentPrice) : null;

  return {
    ...item,
    purchases,
    totalQty,
    totalSpent: totalQty > 0 ? totalSpent : null,
    avgBuyPrice,
    totalValue: currentPrice && totalQty > 0 ? currentPrice * totalQty : null,
    totalPnl: currentPrice && totalQty > 0 ? (currentPrice * totalQty) - totalSpent : null,
    pnlPct: avgBuyPrice && currentPrice ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100 : null
  };
}

// Pomocnik do agregacji zakupów (dla GET /api/watchlist)
async function enrichWithPurchases(row) {
  const purch = await pool.query(
    `SELECT id, quantity, buy_price AS "buyPrice", bought_at AS "boughtAt", note
     FROM purchases WHERE watchlist_id = $1 ORDER BY bought_at ASC`,
    [row.id]
  );
  const purchases = purch.rows;
  const totalQty = purchases.reduce((s, p) => s + Number(p.quantity), 0);
  const totalSpent = purchases.reduce((s, p) => s + Number(p.quantity) * parseFloat(p.buyPrice), 0);
  const avgBuyPrice = totalQty > 0 ? totalSpent / totalQty : null;
  const currentPrice = row.currentPrice ? parseFloat(row.currentPrice) : null;
  return {
    ...row,
    purchases,  // ← tablica zakupów do wyświetlenia w tabeli
    totalQty,
    totalSpent: totalQty > 0 ? totalSpent : null,
    avgBuyPrice,
    totalValue: currentPrice && totalQty > 0 ? currentPrice * totalQty : null,
    totalPnl: currentPrice && totalQty > 0 ? (currentPrice * totalQty) - totalSpent : null,
    pnlPct: avgBuyPrice && currentPrice ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100 : null
  };
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
    res.json({ token: createToken(result.rows[0].id) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'email_exists' });
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── AUTH: logowanie ─────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1', [email]
    );
    if (!result.rowCount) return res.status(400).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'invalid_credentials' });
    res.json({ token: createToken(result.rows[0].id) });
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

    // Dla itemów bez ceny — pobierz w tle (nie blokuj odpowiedzi)
    result.rows.forEach(row => {
      if (!row.currentPrice) {
        fetchSteamPrice(row.market_hash).then(price => {
          if (price) {
            pool.query(
              `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
               SELECT i.id, $2, $3, $4, NOW() FROM items i WHERE i.market_hash = $1`,
              [row.market_hash, price.lowest_price, price.median_price, price.volume]
            ).catch(e => console.error('bg price insert error:', e.message));
          }
        }).catch(() => {});
      }
    });

    const rows = await Promise.all(result.rows.map(enrichWithPurchases));
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: dodawanie ─────────────────
app.post('/api/watchlist', auth, async (req, res) => {
  try {
    const { marketHashName, name, imageUrl } = req.body;
    if (!marketHashName || !name)
      return res.status(400).json({ error: 'missing_fields' });

    const itemRes = await pool.query(
      `INSERT INTO items (market_hash, name, image_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (market_hash)
       DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
       RETURNING id`,
      [marketHashName, name, imageUrl || null]
    );
    const itemId = itemRes.rows[0].id;

    const existing = await pool.query(
      'SELECT id FROM watchlist WHERE user_id = $1 AND item_id = $2',
      [req.userId, itemId]
    );
    if (existing.rowCount > 0) return res.status(409).json({ error: 'already_exists' });

    const wRes = await pool.query(
      `INSERT INTO watchlist (user_id, item_id) VALUES ($1, $2) RETURNING id`,
      [req.userId, itemId]
    );
    const watchlistId = wRes.rows[0].id;

    const price = await fetchSteamPrice(marketHashName);
    if (price) {
      await pool.query(
        `INSERT INTO prices (item_id, lowest_price, median_price, volume, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [itemId, price.lowest_price, price.median_price, price.volume]
      );
    }

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
    await pool.query('DELETE FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── PURCHASES: pobieranie ─────────────────
app.get('/api/purchases/:watchlistId', auth, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.watchlistId, req.userId]
    );
    if (!check.rowCount) return res.status(404).json({ error: 'not_found' });

    const result = await pool.query(
      `SELECT id, quantity, buy_price AS "buyPrice", bought_at AS "boughtAt", note
       FROM purchases WHERE watchlist_id = $1 ORDER BY bought_at ASC`,
      [req.params.watchlistId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── PURCHASES: dodawanie ─────────────────
app.post('/api/purchases/:watchlistId', auth, async (req, res) => {
  try {
    const { quantity, buyPrice, note } = req.body;
    if (!quantity || !buyPrice || quantity < 1 || buyPrice <= 0)
      return res.status(400).json({ error: 'invalid_data' });

    const check = await pool.query(
      'SELECT id FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.watchlistId, req.userId]
    );
    if (!check.rowCount) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `INSERT INTO purchases (watchlist_id, quantity, buy_price, note)
       VALUES ($1, $2, $3, $4)`,
      [req.params.watchlistId, quantity, buyPrice, note || null]
    );

    const item = await getWatchlistItem(req.params.watchlistId, req.userId);
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── PURCHASES: usuwanie ─────────────────
app.delete('/api/purchases/:watchlistId/:purchaseId', auth, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.watchlistId, req.userId]
    );
    if (!check.rowCount) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      'DELETE FROM purchases WHERE id = $1 AND watchlist_id = $2',
      [req.params.purchaseId, req.params.watchlistId]
    );

    const item = await getWatchlistItem(req.params.watchlistId, req.userId);
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
    const itemRes = await pool.query(
      `SELECT i.id, i.market_hash FROM items i
       JOIN watchlist w ON w.item_id = i.id
       WHERE w.id = $1 AND w.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!itemRes.rowCount) return res.status(404).json({ error: 'not_found' });

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

// ───────────────── REFRESH: wszystkie itemy ─────────────────
app.post('/api/refresh-all', auth, async (req, res) => {
  res.json({ ok: true });
  try {
    const result = await pool.query(
      `SELECT i.id, i.market_hash FROM items i
       JOIN watchlist w ON w.item_id = i.id
       WHERE w.user_id = $1`,
      [req.userId]
    );
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
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://steamcommunity.com/market/', 'Accept': 'application/json' },
      timeout: 12000
    });
    if (!response.data?.results) return res.json([]);

    const raw = response.data.results.slice(0, 10);
    const pricePromises = raw.slice(0, 6).map(i => fetchSteamPrice(i.hash_name).catch(() => null));
    const prices = await Promise.all(pricePromises);

    res.json(raw.map((i, idx) => ({
      name: i.name,
      marketHashName: i.hash_name,
      price: prices[idx]?.lowest_price ?? null,
      imageUrl: i.asset_description?.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f`
        : null
    })));
  } catch (e) {
    console.error('Steam search error:', e.message);
    res.status(502).json({ error: 'steam_search_failed' });
  }
});

// ───────────────── AUTO REFRESH (co godzinę) ─────────────────
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
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: result.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ───────────────── SPA fallback ─────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ───────────────── START ─────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`CS2 Tracker running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
