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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// ───────────────── Refresh jednego itema (core logic) ─────────────────
async function refreshItem(itemId) {
  // pobierz item z DB
  const itemRes = await pool.query(
    'SELECT id, market_hash FROM items WHERE id = $1',
    [itemId]
  );
  if (!itemRes.rowCount) return null;

  const item = itemRes.rows[0];
  const price = await fetchSteamPrice(item.market_hash);
  if (!price) return null;

  // zapisz nową cenę do historii
  await pool.query(
    `INSERT INTO price_history (item_id, lowest_price, median_price, volume, recorded_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [item.id, price.lowest_price, price.median_price, price.volume]
  );

  // zaktualizuj aktualną cenę w items
  await pool.query(
    `UPDATE items SET current_price = $1, current_median = $2, current_volume = $3, last_updated = NOW()
     WHERE id = $4`,
    [price.lowest_price, price.median_price, price.volume, item.id]
  );

  return price;
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
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url,
              i.current_price, i.current_median, i.current_volume,
              i.last_updated, w.buy_price
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.userId]
    );

    // mapuj do formatu oczekiwanego przez frontend
    const rows = result.rows.map(r => ({
      id: r.id,
      item_id: r.item_id,
      name: r.name,
      market_hash: r.market_hash,
      imageUrl: r.image_url,
      currentPrice: r.current_price,
      currentMedian: r.current_median,
      currentVolume: r.current_volume,
      lastUpdated: r.last_updated ? new Date(r.last_updated).getTime() : null,
      buyPrice: r.buy_price
    }));

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: dodawanie ─────────────────
app.post('/api/watchlist', auth, async (req, res) => {
  try {
    const { marketHashName, name, imageUrl, buyPrice } = req.body;

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
      `INSERT INTO watchlist (user_id, item_id, buy_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_id) DO NOTHING`,
      [req.userId, itemId, buyPrice || null]
    );

    res.json({ ok: true, id: itemId, name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── WATCHLIST: aktualizacja (buy price) ─────────────────
app.patch('/api/watchlist/:watchlistId', auth, async (req, res) => {
  try {
    const watchlistId = Number(req.params.watchlistId);
    const { buyPrice } = req.body;

    await pool.query(
      'UPDATE watchlist SET buy_price = $1 WHERE id = $2 AND user_id = $3',
      [buyPrice || null, watchlistId, req.userId]
    );

    // zwróć zaktualizowany wpis
    const result = await pool.query(
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url,
              i.current_price, i.current_median, i.current_volume,
              i.last_updated, w.buy_price
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       WHERE w.id = $1`,
      [watchlistId]
    );

    if (!result.rowCount) return res.status(404).json({ error: 'not_found' });

    const r = result.rows[0];
    res.json({
      id: r.id,
      item_id: r.item_id,
      name: r.name,
      market_hash: r.market_hash,
      imageUrl: r.image_url,
      currentPrice: r.current_price,
      currentMedian: r.current_median,
      currentVolume: r.current_volume,
      lastUpdated: r.last_updated ? new Date(r.last_updated).getTime() : null,
      buyPrice: r.buy_price
    });
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

// ───────────────── REFRESH: jeden przedmiot ─────────────────
app.post('/api/refresh/:itemId', auth, async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);

    // sprawdź czy item należy do usera
    const check = await pool.query(
      'SELECT w.id FROM watchlist w WHERE w.item_id = $1 AND w.user_id = $2',
      [itemId, req.userId]
    );
    if (!check.rowCount) return res.status(403).json({ error: 'forbidden' });

    const price = await refreshItem(itemId);
    if (!price) return res.status(502).json({ error: 'steam_error' });

    res.json({ ok: true, price });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ───────────────── REFRESH ALL: kolejkowanie z SSE ─────────────────
// Używamy Server-Sent Events żeby frontend widział postęp na żywo
app.post('/api/refresh-all', auth, async (req, res) => {
  try {
    // pobierz wszystkie itemy usera
    const result = await pool.query(
      `SELECT DISTINCT i.id, i.name, i.market_hash
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       WHERE w.user_id = $1
       ORDER BY i.name`,
      [req.userId]
    );

    const items = result.rows;
    if (!items.length) return res.json({ ok: true, updated: 0, total: 0 });

    // Ustaw SSE headers żeby frontend dostawał aktualizacje na żywo
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: 'start', total: items.length });

    let updated = 0;
    let errors = 0;
    const DELAY_MS = 3500; // 3.5s między requestami — bezpiecznie poniżej limitu Steam

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      send({ type: 'progress', index: i, total: items.length, name: item.name });

      try {
        const price = await refreshItem(item.id);
        if (price) {
          updated++;
          send({ type: 'item_done', itemId: item.id, name: item.name, price, index: i });
        } else {
          errors++;
          send({ type: 'item_error', itemId: item.id, name: item.name, index: i });
        }
      } catch (err) {
        errors++;
        send({ type: 'item_error', itemId: item.id, name: item.name, index: i });
        console.error(`Error refreshing item ${item.id}:`, err.message);
      }

      // czekaj przed kolejnym requestem (poza ostatnim)
      if (i < items.length - 1) {
        await delay(DELAY_MS);
      }
    }

    send({ type: 'done', updated, errors, total: items.length });
    res.end();

  } catch (e) {
    console.error(e);
    // jeśli jeszcze nie wysłano nagłówków
    if (!res.headersSent) {
      res.status(500).json({ error: 'server_error' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'server_error' })}\n\n`);
      res.end();
    }
  }
});

// ───────────────── HISTORY ─────────────────
app.get('/api/history/:itemId', auth, async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);

    // sprawdź dostęp
    const check = await pool.query(
      'SELECT w.id FROM watchlist w WHERE w.item_id = $1 AND w.user_id = $2',
      [itemId, req.userId]
    );
    if (!check.rowCount) return res.status(403).json({ error: 'forbidden' });

    const result = await pool.query(
      `SELECT lowest_price AS lowest, median_price AS median, volume,
              EXTRACT(EPOCH FROM recorded_at) * 1000 AS ts
       FROM price_history
       WHERE item_id = $1
       ORDER BY recorded_at ASC
       LIMIT 720`,  // max 30 dni przy odświeżaniu co 1h
      [itemId]
    );

    res.json(result.rows.map(r => ({
      lowest: parseFloat(r.lowest),
      median: parseFloat(r.median),
      volume: r.volume,
      ts: Math.round(parseFloat(r.ts))
    })));
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
