'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { scrapeAmazon, extractAsin } = require('./src/scrapers/amazon');
const { scrapeGeneric } = require('./src/scrapers/generic');
const { composePin } = require('./src/composer');
const { listBoards, findBoard, createBoard } = require('./src/pinterest/boards');
const { createPinWithRetry } = require('./src/pinterest/client');
const { polishPin } = require('./src/ai/polish');
const { logSuccess, logFailure } = require('./src/logger');
const { getAccessToken, exchangeCode, setRuntimeToken } = require('./src/pinterest/auth');

const app = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());

// Read pinterest_token cookie and inject into runtime token store
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)pinterest_token=([^;]+)/);
  if (match) setRuntimeToken(decodeURIComponent(match[1]));
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ─────────────────────────────────────────────
async function scrapeUrl(url) {
  const isAmazon = /amazon\.(com|co\.uk|de|fr|ca|com\.au|in|co\.jp)/i.test(url)
    || /amzn\.to\//i.test(url)
    || /amzn\.eu\//i.test(url)
    || extractAsin(url);
  return isAmazon ? scrapeAmazon(url) : scrapeGeneric(url);
}

function parseCSVText(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cols = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || [];
    const row = {};
    header.forEach((key, i) => {
      row[key] = (cols[i] || '').replace(/^"|"$/g, '').trim();
    });
    return row;
  }).filter(r => r.product_url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Auth Routes ──────────────────────────────────────────

// GET /auth/status
app.get('/auth/status', async (req, res) => {
  try {
    await getAccessToken();
    res.json({ connected: true });
  } catch {
    res.json({ connected: false });
  }
});

// GET /auth/login  →  redirects to Pinterest OAuth
app.get('/auth/login', (req, res) => {
  const appId = process.env.PINTEREST_APP_ID;
  if (!appId) return res.status(500).send('PINTEREST_APP_ID not configured');

  const redirectUri = process.env.REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}/auth/callback`;

  const scopes = 'pins:read,pins:write,boards:read,boards:write,user_accounts:read';
  const authUrl =
    `https://www.pinterest.com/oauth/?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.redirect(authUrl);
});

// GET /auth/callback and /callback  →  exchange code, save token, redirect to UI
async function handleOAuthCallback(req, res) {
  const { code, error } = req.query;
  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?auth_error=missing_code');

  try {
    const redirectUri = process.env.REDIRECT_URI ||
      `${req.protocol}://${req.get('host')}/auth/callback`;
    const tokens = await exchangeCode(code, redirectUri);
    // Store token in a long-lived cookie (1 year) — works on read-only filesystems
    res.setHeader('Set-Cookie',
      `pinterest_token=${encodeURIComponent(tokens.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
    );
    res.redirect('/?connected=1');
  } catch (err) {
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
}

app.get('/auth/callback', handleOAuthCallback);
app.get('/callback', handleOAuthCallback);

// GET /auth/logout  →  clear cookie and redirect home
app.get('/auth/logout', (req, res) => {
  setRuntimeToken(null);
  res.setHeader('Set-Cookie', 'pinterest_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/');
});

// ─── API Routes ───────────────────────────────────────────

// GET /api/boards
app.get('/api/boards', async (req, res) => {
  try {
    const boards = await listBoards();
    res.json({ boards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/boards  { name, privacy }
app.post('/api/boards', async (req, res) => {
  const { name, privacy = 'PUBLIC' } = req.body;
  if (!name) return res.status(400).json({ error: 'Board name is required' });
  try {
    const board = await createBoard(name, privacy);
    res.json({ board });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/preview  { url, affiliateUrl, board, hashtags, ai }
app.post('/api/preview', async (req, res) => {
  const { url, board = 'PREVIEW', hashtags = [], ai = false } = req.body;
  const affiliateUrl = req.body.affiliateUrl || url;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const productData = await scrapeUrl(url);
    let tags = Array.isArray(hashtags) ? hashtags : hashtags.split(',').map(t => t.trim()).filter(Boolean);

    if (ai) {
      try {
        const polished = await polishPin(productData, tags);
        productData.title = polished.title;
        productData.description = polished.description;
        tags = [];
      } catch (e) {
        // fall through with original
      }
    }

    const pin = composePin(productData, affiliateUrl, board, tags);
    res.json({
      pin,
      meta: {
        asin: productData.asin || null,
        price: productData.price || null,
        titleLen: pin.title.length,
        descLen: pin.description.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/post  { url, affiliateUrl, board, hashtags, ai }
app.post('/api/post', async (req, res) => {
  const { url, board, hashtags = [], ai = false } = req.body;
  const affiliateUrl = req.body.affiliateUrl || url;
  if (!url || !board) {
    return res.status(400).json({ error: 'url and board are required' });
  }

  try {
    const productData = await scrapeUrl(url);
    let tags = Array.isArray(hashtags) ? hashtags : hashtags.split(',').map(t => t.trim()).filter(Boolean);

    if (ai) {
      try {
        const polished = await polishPin(productData, tags);
        productData.title = polished.title;
        productData.description = polished.description;
        tags = [];
      } catch (e) { /* use original */ }
    }

    const pin = composePin(productData, affiliateUrl, board, tags);
    const result = await createPinWithRetry(pin);

    logSuccess({ url, affiliateUrl, pinId: result.id, pinUrl: result.url });
    res.json({ success: true, pinId: result.id, pinUrl: result.url });
  } catch (err) {
    logFailure({ url, affiliateUrl, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/batch  multipart: file=csv, body: { board, ai, delay }
app.post('/api/batch', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  const { board = '', ai = false, delay = 12000 } = req.body;
  const pinDelay = parseInt(delay, 10);
  const useAi = ai === 'true' || ai === true;

  const csvText = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);

  const rows = parseCSVText(csvText);
  if (!rows.length) return res.status(400).json({ error: 'No valid rows in CSV' });

  // Run in background, stream results via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', total: rows.length });

  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowBoard = row.board_name || board || process.env.DEFAULT_BOARD_ID || '';

    try {
      const productData = await scrapeUrl(row.product_url);
      let tags = [];

      if (useAi) {
        try {
          const polished = await polishPin(productData, tags);
          productData.title = polished.title;
          productData.description = polished.description;
        } catch (e) { /* use original */ }
      }

      const affiliateUrl = row.affiliate_url || row.product_url;
      const pin = composePin(productData, affiliateUrl, rowBoard, tags);
      const result = await createPinWithRetry(pin);

      logSuccess({ url: row.product_url, affiliateUrl, pinId: result.id, pinUrl: result.url });
      send({ type: 'progress', index: i + 1, total: rows.length, status: 'ok', url: row.product_url, pinUrl: result.url });
      success++;
    } catch (err) {
      logFailure({ url: row.product_url, affiliateUrl: row.affiliate_url || row.product_url, error: err.message });
      send({ type: 'progress', index: i + 1, total: rows.length, status: 'error', url: row.product_url, error: err.message });
      failed++;
    }

    if (i < rows.length - 1) await sleep(pinDelay);
  }

  send({ type: 'done', success, failed });
  res.end();
});

// ─── Start ────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`\n  Pin Creator Web UI`);
    console.log(`  Running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
