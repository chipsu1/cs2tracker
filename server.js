const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join('/tmp', 'cs2tracker_data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { watchlist: [], priceHistory: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { watchlist: [], priceHistory: {} }; }
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

async function fetchSteamPrice(itemName) {
  const encoded = encodeURIComponent(itemName);
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encoded}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://steamcommunity.com/market/',
      },
      timeout: 12000,
    });
    const d = response.data;
    if (!d.success) return null;
    const parsePrice = (str) => {
      if (!str) return null;
      const cleaned = str.replace(/[^\d.,]/g, '');
      const normalized = cleaned.replace(/\.(?=\d{3})/g, '').replace(',', '.');
      return parseFloat(normalized) || null;
    };
    return {
      lowest_price: parsePrice(d.lowest_price),
      median_price: parsePrice(d.median_price),
      volume: parseInt((d.volume || '0').replace(/[^\d]/g, '')) || 0,
      lowest_price_raw: d.lowest_price || '—',
      timestamp: Date.now(),
    };
  } catch (e) {
    console.error(`Steam error for "${itemName}":`, e.message);
    return null;
  }
}

async function recordPriceSnapshots() {
  const data = loadData();
  if (!data.watchlist.length) return;
  console.log(`[${new Date().toISOString()}] Snapshotting ${data.watchlist.length} items...`);
  for (const item of data.watchlist) {
    await new Promise(r => setTimeout(r, 3500));
    const price = await fetchSteamPrice(item.marketHashName);
    if (price) {
      if (!data.priceHistory[item.id]) data.priceHistory[item.id] = [];
      data.priceHistory[item.id].push({ ts: price.timestamp, lowest: price.lowest_price, median: price.median_price, volume: price.volume });
      if (data.priceHistory[item.id].length > 720) data.priceHistory[item.id] = data.priceHistory[item.id].slice(-720);
      item.currentPrice = price.lowest_price;
      item.currentMedian = price.median_price;
      item.currentVolume = price.volume;
      item.lastUpdated = price.timestamp;
    }
  }
  saveData(data);
}

app.get('/api/watchlist', (req, res) => res.json(loadData().watchlist));

app.post('/api/watchlist', async (req, res) => {
  const { name, marketHashName, buyPrice, imageUrl } = req.body;
  if (!name || !marketHashName) return res.status(400).json({ error: 'name and marketHashName required' });
  const data = loadData();
  if (data.watchlist.find(w => w.marketHashName === marketHashName)) return res.status(409).json({ error: 'Already exists' });
  const price = await fetchSteamPrice(marketHashName);
  const item = { id: Date.now().toString(), name, marketHashName, buyPrice: buyPrice || null, imageUrl: imageUrl || null, currentPrice: price?.lowest_price || null, currentMedian: price?.median_price || null, currentVolume: price?.volume || 0, lastUpdated: price?.timestamp || null, addedAt: Date.now() };
  data.watchlist.push(item);
  if (price) { if (!data.priceHistory[item.id]) data.priceHistory[item.id] = []; data.priceHistory[item.id].push({ ts: price.timestamp, lowest: price.lowest_price, median: price.median_price, volume: price.volume }); }
  saveData(data);
  res.json(item);
});

app.patch('/api/watchlist/:id', (req, res) => {
  const data = loadData();
  const item = data.watchlist.find(w => w.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (req.body.buyPrice !== undefined) item.buyPrice = req.body.buyPrice;
  saveData(data);
  res.json(item);
});

app.delete('/api/watchlist/:id', (req, res) => {
  const data = loadData();
  const idx = data.watchlist.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = data.watchlist.splice(idx, 1);
  delete data.priceHistory[removed.id];
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/history/:id', (req, res) => res.json(loadData().priceHistory[req.params.id] || []));

app.post('/api/refresh/:id', async (req, res) => {
  const data = loadData();
  const item = data.watchlist.find(w => w.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const price = await fetchSteamPrice(item.marketHashName);
  if (!price) return res.status(502).json({ error: 'Steam fetch failed' });
  item.currentPrice = price.lowest_price; item.currentMedian = price.median_price; item.currentVolume = price.volume; item.lastUpdated = price.timestamp;
  if (!data.priceHistory[item.id]) data.priceHistory[item.id] = [];
  data.priceHistory[item.id].push({ ts: price.timestamp, lowest: price.lowest_price, median: price.median_price, volume: price.volume });
  saveData(data);
  res.json({ item, price });
});

app.post('/api/refresh-all', (req, res) => { res.json({ ok: true }); recordPriceSnapshots(); });

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&appid=730&search_descriptions=0&sort_column=popular&sort_dir=desc&currency=1&count=10`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://steamcommunity.com/market/' }, timeout: 12000 });
    const items = (response.data?.results || []).map(i => ({ name: i.name, marketHashName: i.hash_name, price: i.sell_price_text, imageUrl: i.asset_description?.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${i.asset_description.icon_url}/96fx96f` : null }));
    res.json(items);
  } catch (e) { res.status(502).json({ error: 'Steam search failed' }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, items: loadData().watchlist.length, time: new Date().toISOString() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('0 * * * *', recordPriceSnapshots);

app.listen(PORT, () => {
  console.log(`CS2 Tracker running on port ${PORT}`);
  setTimeout(recordPriceSnapshots, 8000);
});
