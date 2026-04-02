const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function createToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' }); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { const p = jwt.verify(token, JWT_SECRET); req.userId = p.userId; next(); }
  catch { return res.status(401).json({ error: 'invalid_token' }); }
}

function normalizeSteamPrice(str) {
  if (!str) return null;
  let c = str.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
  const v = parseFloat(c);
  return isNaN(v) ? null : v;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchSteamPrice(marketHash) {
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=6&market_hash_name=${encodeURIComponent(marketHash)}`;
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://steamcommunity.com/market/' },
      timeout: 12000
    });
    if (!r.data.success) return null;
    return {
      lowest_price: normalizeSteamPrice(r.data.lowest_price),
      median_price: normalizeSteamPrice(r.data.median_price),
      volume: parseInt((r.data.volume || '0').replace(/[^\d]/g, '')) || 0,
      timestamp: Date.now()
    };
  } catch (e) { console.error(`Steam error "${marketHash}":`, e.message); return null; }
}

async function refreshItem(itemId) {
  const itemRes = await pool.query('SELECT id, market_hash FROM items WHERE id=$1', [itemId]);
  if (!itemRes.rowCount) return null;
  const item = itemRes.rows[0];
  const price = await fetchSteamPrice(item.market_hash);
  if (!price) return null;
  await pool.query(
    'INSERT INTO price_history (item_id, lowest_price, median_price, volume, recorded_at) VALUES ($1,$2,$3,$4,NOW())',
    [item.id, price.lowest_price, price.median_price, price.volume]
  );
  await pool.query(
    'UPDATE items SET current_price=$1, current_median=$2, current_volume=$3, last_updated=NOW() WHERE id=$4',
    [price.lowest_price, price.median_price, price.volume, item.id]
  );
  return price;
}

// AUTH
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id', [email, hash]);
    res.json({ token: createToken(r.rows[0].id) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'email_exists' });
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT id, password_hash FROM users WHERE email=$1', [email]);
    if (!r.rowCount) return res.status(400).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'invalid_credentials' });
    res.json({ token: createToken(r.rows[0].id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// WATCHLIST z purchases
app.get('/api/watchlist', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url,
              i.current_price, i.current_median, i.current_volume, i.last_updated,
              COALESCE(SUM(p.quantity),0) AS total_quantity,
              COALESCE(SUM(p.quantity * p.buy_price),0) AS total_cost,
              json_agg(json_build_object('id',p.id,'quantity',p.quantity,'buy_price',p.buy_price,'bought_at',p.bought_at,'note',p.note) ORDER BY p.bought_at DESC) FILTER (WHERE p.id IS NOT NULL) AS purchases
       FROM watchlist w
       JOIN items i ON i.id=w.item_id
       LEFT JOIN purchases p ON p.watchlist_id=w.id
       WHERE w.user_id=$1
       GROUP BY w.id, i.id
       ORDER BY w.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows.map(r => {
      const cp = r.current_price ? parseFloat(r.current_price) : null;
      const totalQty = parseInt(r.total_quantity) || 0;
      const totalSpent = parseFloat(r.total_cost) || 0;
      const totalValue = cp && totalQty ? cp * totalQty : null;
      const totalPnl = totalValue != null ? totalValue - totalSpent : null;
      const pnlPct = totalPnl != null && totalSpent > 0 ? (totalPnl / totalSpent) * 100 : null;
      const avgBuyPrice = totalQty > 0 ? totalSpent / totalQty : null;
      return {
        id: r.id, item_id: r.item_id, name: r.name, market_hash: r.market_hash, imageUrl: r.image_url,
        currentPrice: cp,
        currentMedian: r.current_median ? parseFloat(r.current_median) : null,
        currentVolume: r.current_volume || 0,
        lastUpdated: r.last_updated ? new Date(r.last_updated).getTime() : null,
        totalQty, totalSpent, totalValue, totalPnl, pnlPct, avgBuyPrice,
        // keep old names too for compat
        totalQuantity: totalQty, totalCost: totalSpent,
        purchases: r.purchases || []
      };
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/watchlist', auth, async (req, res) => {
  try {
    const { marketHashName, name, imageUrl } = req.body;
    const iRes = await pool.query(
      `INSERT INTO items (market_hash,name,image_url) VALUES ($1,$2,$3)
       ON CONFLICT (market_hash) DO UPDATE SET name=EXCLUDED.name, image_url=EXCLUDED.image_url RETURNING id`,
      [marketHashName, name, imageUrl]
    );
    const itemId = iRes.rows[0].id;
    const wRes = await pool.query(
      `INSERT INTO watchlist (user_id,item_id) VALUES ($1,$2) ON CONFLICT (user_id,item_id) DO UPDATE SET item_id=EXCLUDED.item_id RETURNING id`,
      [req.userId, itemId]
    );
    res.json({ ok: true, id: wRes.rows[0].id, item_id: itemId, name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/watchlist/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM watchlist WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// PURCHASES - POST /api/purchases/:watchlistId
app.post('/api/purchases/:watchlistId', auth, async (req, res) => {
  try {
    const wId = Number(req.params.watchlistId);
    const { quantity, buyPrice, note } = req.body;
    const check = await pool.query('SELECT id FROM watchlist WHERE id=$1 AND user_id=$2', [wId, req.userId]);
    if (!check.rowCount) return res.status(403).json({ error: 'forbidden' });
    await pool.query(
      'INSERT INTO purchases (watchlist_id,quantity,buy_price,note,bought_at) VALUES ($1,$2,$3,$4,NOW())',
      [wId, quantity, buyPrice, note || null]
    );
    // Return updated watchlist item
    const updated = await getWatchlistItem(wId, req.userId);
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// DELETE /api/purchases/:watchlistId/:purchaseId
app.delete('/api/purchases/:watchlistId/:purchaseId', auth, async (req, res) => {
  try {
    const wId = Number(req.params.watchlistId);
    const pid = Number(req.params.purchaseId);
    await pool.query(
      'DELETE FROM purchases p USING watchlist w WHERE p.id=$1 AND p.watchlist_id=w.id AND w.user_id=$2',
      [pid, req.userId]
    );
    const updated = await getWatchlistItem(wId, req.userId);
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

async function getWatchlistItem(wId, userId) {
  const r = await pool.query(
    `SELECT w.id, i.id AS item_id, i.name, i.market_hash, i.image_url,
            i.current_price, i.current_median, i.current_volume, i.last_updated,
            COALESCE(SUM(p.quantity),0) AS total_quantity,
            COALESCE(SUM(p.quantity*p.buy_price),0) AS total_cost,
            json_agg(json_build_object('id',p.id,'quantity',p.quantity,'buy_price',p.buy_price,'bought_at',p.bought_at,'note',p.note) ORDER BY p.bought_at DESC) FILTER (WHERE p.id IS NOT NULL) AS purchases
     FROM watchlist w JOIN items i ON i.id=w.item_id LEFT JOIN purchases p ON p.watchlist_id=w.id
     WHERE w.id=$1 AND w.user_id=$2 GROUP BY w.id, i.id`,
    [wId, userId]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  const cp = row.current_price ? parseFloat(row.current_price) : null;
  const totalQty = parseInt(row.total_quantity) || 0;
  const totalSpent = parseFloat(row.total_cost) || 0;
  const totalValue = cp && totalQty ? cp * totalQty : null;
  const totalPnl = totalValue != null ? totalValue - totalSpent : null;
  const pnlPct = totalPnl != null && totalSpent > 0 ? (totalPnl / totalSpent) * 100 : null;
  return {
    id: row.id, item_id: row.item_id, name: row.name, imageUrl: row.image_url,
    currentPrice: cp, currentMedian: row.current_median ? parseFloat(row.current_median) : null,
    currentVolume: row.current_volume || 0,
    lastUpdated: row.last_updated ? new Date(row.last_updated).getTime() : null,
    totalQty, totalSpent, totalValue, totalPnl, pnlPct,
    avgBuyPrice: totalQty > 0 ? totalSpent / totalQty : null,
    totalQuantity: totalQty, totalCost: totalSpent,
    purchases: row.purchases || []
  };
}

// REFRESH
app.post('/api/refresh/:itemId', auth, async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const check = await pool.query('SELECT w.id FROM watchlist w WHERE w.item_id=$1 AND w.user_id=$2', [itemId, req.userId]);
    if (!check.rowCount) return res.status(403).json({ error: 'forbidden' });
    const price = await refreshItem(itemId);
    if (!price) return res.status(502).json({ error: 'steam_error' });
    res.json({ ok: true, price });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/refresh-all', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT i.id, i.name FROM watchlist w JOIN items i ON i.id=w.item_id WHERE w.user_id=$1 ORDER BY i.name`,
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
        const price = await refreshItem(item.id);
        if (price) { updated++; send({ type: 'item_done', itemId: item.id, price, index: i }); }
        else { errors++; send({ type: 'item_error', itemId: item.id, name: item.name, index: i }); }
      } catch { errors++; send({ type: 'item_error', itemId: item.id, name: item.name, index: i }); }
      if (i < items.length - 1) await delay(3500);
    }
    send({ type: 'done', updated, errors, total: items.length });
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    else { res.write(`data: ${JSON.stringify({ type: 'error' })}\n\n`); res.end(); }
  }
});

// HISTORY
app.get('/api/history/:itemId', auth, async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const check = await pool.query('SELECT w.id FROM watchlist w WHERE w.item_id=$1 AND w.user_id=$2', [itemId, req.userId]);
    if (!check.rowCount) return res.status(403).json({ error: 'forbidden' });
    const r = await pool.query(
      `SELECT lowest_price AS lowest, median_price AS median, volume, EXTRACT(EPOCH FROM recorded_at)*1000 AS ts
       FROM price_history WHERE item_id=$1 ORDER BY recorded_at ASC LIMIT 720`,
      [itemId]
    );
    res.json(r.rows.map(row => ({ lowest: parseFloat(row.lowest), median: parseFloat(row.median), volume: row.volume, ts: Math.round(parseFloat(row.ts)) })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// SEARCH
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&appid=730&search_descriptions=0&sort_column=popular&sort_dir=desc&currency=6&count=10&format=json&norender=1`;
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://steamcommunity.com/market/', 'Accept': 'application/json' }, timeout: 12000 });
    if (!r.data?.results) return res.json([]);
    res.json(r.data.results.map(i => ({
      name: i.name, marketHashName: i.hash_name,
      price: normalizeSteamPrice(i.sell_price_text),
      imageUrl: i.asset_description?.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f` : null
    })));
  } catch (e) { console.error('Search error:', e.message); res.status(502).json({ error: 'steam_search_failed' }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`CS2 Tracker on port ${PORT}`));
