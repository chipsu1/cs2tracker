// ─────────────────────────────────────────────────────────────
//  CS2 TRACKER
// ─────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const { Pool }= require('pg');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

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
      cached_price NUMERIC(10,2),
      cached_median NUMERIC(10,2),
      cached_volume INTEGER,
      cache_updated_at TIMESTAMPTZ,
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
  `);

  // Migracje: dodaj brakujące kolumny cache jeśli nie istnieją
  try {
    await pool.query(`
      ALTER TABLE items
        ADD COLUMN IF NOT EXISTS cached_price NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS cached_median NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS cached_volume INTEGER,
        ADD COLUMN IF NOT EXISTS cache_updated_at TIMESTAMPTZ
    `);
  } catch(e) {}

  // Migracja: skopiuj current_price → cached_price jeśli kolumna istnieje
  try {
    await pool.query(`
      UPDATE items SET
        cached_price    = COALESCE(cached_price, current_price),
        cached_median   = COALESCE(cached_median, current_median),
        cached_volume   = COALESCE(cached_volume, current_volume),
        cache_updated_at = COALESCE(cache_updated_at, last_updated)
      WHERE cached_price IS NULL AND current_price IS NOT NULL
    `);
  } catch(e) {}

  // Usuń starą kolumnę buy_price z watchlist jeśli istnieje
  try { await pool.query(`ALTER TABLE watchlist DROP COLUMN IF EXISTS buy_price`); } catch(e) {}

  console.log('DB schema OK');
}

// ───────────────── JWT ─────────────────
function createToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch { return res.status(401).json({ error: 'invalid_token' }); }
}

// ───────────────── Steam helpers ─────────────────
function normalizeSteamPrice(str) {
  if (!str) return null;
  let c = str.replace(/[^\d.,]/g, '');
  const lastComma = c.lastIndexOf(','), lastDot = c.lastIndexOf('.');
  if (lastComma > lastDot) c = c.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) c = c.replace(/,/g, '');
  const v = parseFloat(c);
  return isNaN(v) ? null : v;
}

async function fetchSteamPrice(marketHash) {
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=6&market_hash_name=${encodeURIComponent(marketHash)}`;
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://steamcommunity.com/market/' },
      timeout: 12000
    });
    if (!r.data?.success) return null;
    return {
      lowest_price: normalizeSteamPrice(r.data.lowest_price),
      median_price: normalizeSteamPrice(r.data.median_price),
      volume: parseInt((r.data.volume || '0').replace(/[^\d]/g, '')) || 0
    };
  } catch(e) {
    console.error(`Steam price error "${marketHash}":`, e.message);
    return null;
  }
}

async function updatePriceCache(itemId, price) {
  await pool.query(
    `UPDATE items SET cached_price=$1, cached_median=$2, cached_volume=$3, cache_updated_at=NOW() WHERE id=$4`,
    [price.lowest_price, price.median_price, price.volume, itemId]
  );
}

async function getPurchaseStats(watchlistId) {
  const r = await pool.query(
    `SELECT id, quantity, buy_price AS "buyPrice", bought_at AS "boughtAt", note
     FROM purchases WHERE watchlist_id=$1 ORDER BY bought_at ASC`,
    [watchlistId]
  );
  const purchases = r.rows;
  const totalQty   = purchases.reduce((s, p) => s + Number(p.quantity), 0);
  const totalSpent = purchases.reduce((s, p) => s + Number(p.quantity) * parseFloat(p.buyPrice), 0);
  const avgBuyPrice = totalQty > 0 ? totalSpent / totalQty : null;
  return { purchases, totalQty, totalSpent: totalQty > 0 ? totalSpent : null, avgBuyPrice };
}

function calcPnl(row, stats) {
  const cp = row.currentPrice ? parseFloat(row.currentPrice) : null;
  const { purchases, totalQty, totalSpent, avgBuyPrice } = stats;
  return {
    ...row,
    purchases,
    totalQty,
    totalSpent,
    avgBuyPrice,
    totalValue: cp && totalQty > 0 ? cp * totalQty : null,
    totalPnl:   cp && totalQty > 0 ? (cp * totalQty) - totalSpent : null,
    pnlPct:     avgBuyPrice && cp ? ((cp - avgBuyPrice) / avgBuyPrice) * 100 : null
  };
}

// ───────────────── AUTH ─────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id',
      [email, hash]
    );
    res.json({ token: createToken(r.rows[0].id) });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'email_exists' });
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT id, password_hash FROM users WHERE email=$1', [email]);
    if (!r.rowCount) return res.status(400).json({ error: 'invalid_credentials' });
    if (!await bcrypt.compare(password, r.rows[0].password_hash))
      return res.status(400).json({ error: 'invalid_credentials' });
    res.json({ token: createToken(r.rows[0].id) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ───────────────── WATCHLIST ─────────────────
app.get('/api/watchlist', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url AS "imageUrl",
              i.cached_price AS "currentPrice", i.cached_median AS "currentMedian",
              i.cached_volume AS "currentVolume",
              EXTRACT(EPOCH FROM i.cache_updated_at)*1000 AS "lastUpdated"
       FROM watchlist w
       JOIN items i ON i.id = w.item_id
       WHERE w.user_id=$1
       ORDER BY w.created_at DESC`,
      [req.userId]
    );

    // Itemy bez ceny — odśwież w tle
    result.rows.filter(r => !r.currentPrice).forEach(row => {
      fetchSteamPrice(row.market_hash).then(price => {
        if (price) updatePriceCache(row.item_id, price).catch(() => {});
      }).catch(() => {});
    });

    const rows = await Promise.all(result.rows.map(async row => {
      const stats = await getPurchaseStats(row.id);
      return calcPnl(row, stats);
    }));

    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/watchlist', auth, async (req, res) => {
  try {
    const { marketHashName, name, imageUrl } = req.body;
    if (!marketHashName || !name) return res.status(400).json({ error: 'missing_fields' });

    const itemRes = await pool.query(
      `INSERT INTO items (market_hash, name, image_url)
       VALUES ($1,$2,$3)
       ON CONFLICT (market_hash) DO UPDATE SET name=EXCLUDED.name, image_url=EXCLUDED.image_url
       RETURNING id`,
      [marketHashName, name, imageUrl || null]
    );
    const itemId = itemRes.rows[0].id;

    const existing = await pool.query(
      'SELECT id FROM watchlist WHERE user_id=$1 AND item_id=$2', [req.userId, itemId]
    );
    if (existing.rowCount > 0) return res.status(409).json({ error: 'already_exists' });

    const wRes = await pool.query(
      'INSERT INTO watchlist (user_id, item_id) VALUES ($1,$2) RETURNING id',
      [req.userId, itemId]
    );
    const watchlistId = wRes.rows[0].id;

    const price = await fetchSteamPrice(marketHashName);
    if (price) await updatePriceCache(itemId, price);

    const row = await pool.query(
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url AS "imageUrl",
              i.cached_price AS "currentPrice", i.cached_median AS "currentMedian",
              i.cached_volume AS "currentVolume",
              EXTRACT(EPOCH FROM i.cache_updated_at)*1000 AS "lastUpdated"
       FROM watchlist w JOIN items i ON i.id=w.item_id WHERE w.id=$1`,
      [watchlistId]
    );
    const stats = await getPurchaseStats(watchlistId);
    res.json(calcPnl(row.rows[0], stats));
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/watchlist/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM watchlist WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ───────────────── PURCHASES ─────────────────
async function getFullItem(watchlistId, userId) {
  const r = await pool.query(
    `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url AS "imageUrl",
            i.cached_price AS "currentPrice", i.cached_median AS "currentMedian",
            i.cached_volume AS "currentVolume",
            EXTRACT(EPOCH FROM i.cache_updated_at)*1000 AS "lastUpdated"
     FROM watchlist w JOIN items i ON i.id=w.item_id
     WHERE w.id=$1 AND w.user_id=$2`,
    [watchlistId, userId]
  );
  if (!r.rowCount) return null;
  const stats = await getPurchaseStats(watchlistId);
  return calcPnl(r.rows[0], stats);
}

app.post('/api/purchases/:watchlistId', auth, async (req, res) => {
  try {
    const { quantity, buyPrice, note } = req.body;
    if (!quantity || !buyPrice || quantity < 1 || buyPrice <= 0)
      return res.status(400).json({ error: 'invalid_data' });
    const check = await pool.query(
      'SELECT id FROM watchlist WHERE id=$1 AND user_id=$2', [req.params.watchlistId, req.userId]
    );
    if (!check.rowCount) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      'INSERT INTO purchases (watchlist_id, quantity, buy_price, note) VALUES ($1,$2,$3,$4)',
      [req.params.watchlistId, quantity, buyPrice, note || null]
    );
    res.json(await getFullItem(req.params.watchlistId, req.userId));
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/purchases/:watchlistId/:purchaseId', auth, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM watchlist WHERE id=$1 AND user_id=$2', [req.params.watchlistId, req.userId]
    );
    if (!check.rowCount) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      'DELETE FROM purchases WHERE id=$1 AND watchlist_id=$2',
      [req.params.purchaseId, req.params.watchlistId]
    );
    res.json(await getFullItem(req.params.watchlistId, req.userId));
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ───────────────── HISTORIA (Steam pricehistory) ─────────────────
app.get('/api/history/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.market_hash FROM items i
       JOIN watchlist w ON w.item_id=i.id
       WHERE w.id=$1 AND w.user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    const marketHash = r.rows[0].market_hash;

    try {
      const url = `https://steamcommunity.com/market/pricehistory/?appid=730&currency=6&market_hash_name=${encodeURIComponent(marketHash)}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://steamcommunity.com/market/'
      };
      if (process.env.STEAM_COOKIE) headers['Cookie'] = `steamLoginSecure=${process.env.STEAM_COOKIE}`;

      const response = await axios.get(url, { headers, timeout: 15000 });
      if (response.data?.success && Array.isArray(response.data.prices) && response.data.prices.length > 0) {
        const points = response.data.prices.map(p => {
          const dateStr = p[0].replace(/\s*:\s*\+\d+$/, '').trim();
          const ts = new Date(dateStr).getTime();
          const price = normalizeSteamPrice(String(p[1]));
          return { ts, lowest: price, median: price };
        }).filter(p => !isNaN(p.ts) && p.lowest != null);
        if (points.length > 0) return res.json(points);
      }
    } catch(e) { console.warn('Steam pricehistory failed:', e.message); }

    res.json([]);
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ───────────────── REFRESH jednego itema ─────────────────
app.post('/api/refresh/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.id, i.market_hash FROM items i
       JOIN watchlist w ON w.item_id=i.id
       WHERE w.id=$1 AND w.user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    const { id: itemId, market_hash } = r.rows[0];

    const price = await fetchSteamPrice(market_hash);
    if (!price) return res.status(502).json({ error: 'steam_error' });
    await updatePriceCache(itemId, price);

    res.json(await getFullItem(req.params.id, req.userId));
  } catch(e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ───────────────── REFRESH ALL (SSE — postęp na żywo) ─────────────────
app.post('/api/refresh-all', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT i.id, i.name, i.market_hash
       FROM items i JOIN watchlist w ON w.item_id=i.id
       WHERE w.user_id=$1 ORDER BY i.name`,
      [req.userId]
    );
    const items = result.rows;
    if (!items.length) return res.json({ ok: true, updated: 0, total: 0 });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    send({ type: 'start', total: items.length });

    let updated = 0, errors = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      send({ type: 'progress', index: i, total: items.length, name: item.name });
      try {
        const price = await fetchSteamPrice(item.market_hash);
        if (price) {
          await updatePriceCache(item.id, price);
          updated++;
          send({ type: 'item_done', itemId: item.id, price, index: i });
        } else {
          errors++;
          send({ type: 'item_error', itemId: item.id, name: item.name, index: i });
        }
      } catch {
        errors++;
        send({ type: 'item_error', itemId: item.id, name: item.name, index: i });
      }
      if (i < items.length - 1) await new Promise(r => setTimeout(r, 3500));
    }
    send({ type: 'done', updated, errors, total: items.length });
    res.end();
  } catch(e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    else { res.write(`data: ${JSON.stringify({ type: 'error' })}\n\n`); res.end(); }
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
    const prices = await Promise.all(raw.slice(0, 6).map(i => fetchSteamPrice(i.hash_name).catch(() => null)));

    res.json(raw.map((i, idx) => ({
      name: i.name,
      marketHashName: i.hash_name,
      price: prices[idx]?.lowest_price ?? null,
      imageUrl: i.asset_description?.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f`
        : null
    })));
  } catch(e) { console.error('Steam search error:', e.message); res.status(502).json({ error: 'steam_search_failed' }); }
});

// ───────────────── HEALTH ─────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/db-test', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: r.rows[0].now });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => app.listen(PORT, () => console.log(`CS2 Tracker running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
