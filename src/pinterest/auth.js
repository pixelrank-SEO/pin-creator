'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(process.cwd(), 'tokens.json');
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:4000/auth/callback';
const SANDBOX = process.env.PINTEREST_SANDBOX === 'true';
const AUTH_URL = 'https://www.pinterest.com/oauth/';
const TOKEN_URL = SANDBOX
  ? 'https://api-sandbox.pinterest.com/v5/oauth/token'
  : 'https://api.pinterest.com/v5/oauth/token';

// In-memory token store — used on read-only filesystems (e.g. Vercel)
let _runtimeToken = null;

function setRuntimeToken(token) {
  _runtimeToken = token;
}

/**
 * Load tokens from memory → tokens.json → .env fallback.
 */
function loadTokens() {
  if (_runtimeToken) {
    return { access_token: _runtimeToken, refresh_token: null, expires_at: null };
  }
  if (fs.existsSync(TOKENS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch (_) { /* corrupt file */ }
  }
  if (process.env.PINTEREST_ACCESS_TOKEN) {
    return { access_token: process.env.PINTEREST_ACCESS_TOKEN, refresh_token: null, expires_at: null };
  }
  return null;
}

/**
 * Save tokens to tokens.json (falls back to memory on read-only filesystems).
 */
function saveTokens(tokens) {
  _runtimeToken = tokens.access_token;
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (e) {
    if (e.code !== 'EROFS') throw e;
    // Read-only filesystem (Vercel) — token stored in memory only
  }
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
async function exchangeCode(code, redirectUri = REDIRECT_URI) {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error('PINTEREST_APP_ID and PINTEREST_APP_SECRET must be set in .env');
  }

  const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const data = response.data;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
  saveTokens(tokens);
  return tokens;
}

/**
 * Refresh an expired access token using the refresh token.
 */
async function refreshAccessToken(refreshToken) {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;
  const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const data = response.data;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
  saveTokens(tokens);
  return tokens;
}

/**
 * Get a valid access token, refreshing if expired.
 */
async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error('Not authenticated. Run: node cli.js auth login');
  }

  // Refresh if expired (with a 60s buffer)
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    if (!tokens.refresh_token) {
      throw new Error('Access token expired and no refresh token available. Run: node cli.js auth login');
    }
    console.log('Access token expired — refreshing...');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    return refreshed.access_token;
  }

  return tokens.access_token;
}

/**
 * Run the OAuth 2.0 Authorization Code flow.
 * Opens the browser, waits for the callback, exchanges the code for tokens.
 */
async function login() {
  const appId = process.env.PINTEREST_APP_ID;
  if (!appId) throw new Error('PINTEREST_APP_ID must be set in .env');

  const scopes = 'pins:read,pins:write,boards:read,boards:write,user_accounts:read';
  const authUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}`;

  console.log('\nOpening Pinterest authorization in your browser...');
  console.log('If the browser does not open automatically, visit this URL:\n');
  console.log(authUrl + '\n');

  // Try to open the browser
  try {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${authUrl}"`
      : process.platform === 'darwin'
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
    exec(cmd);
  } catch (_) { /* browser open failed — user can copy the URL */ }

  // Start local callback server
  const code = await waitForCallback();
  console.log('Authorization code received. Exchanging for tokens...');
  const tokens = await exchangeCode(code);
  console.log('Authenticated successfully! Tokens saved to tokens.json');
  return tokens;
}

/**
 * Start a local HTTP server and wait for Pinterest to redirect back with ?code=...
 * Returns the authorization code.
 */
function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, 'http://localhost:3000');
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`Pinterest authorization denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Missing code parameter</h1>');
      }
    });

    server.listen(3000, () => {
      console.log('Waiting for Pinterest callback on http://localhost:3000/callback ...');
    });

    server.on('error', (err) => {
      reject(new Error(`Could not start callback server on port 3000: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout — no response received within 5 minutes.'));
    }, 5 * 60 * 1000);
  });
}

module.exports = { login, getAccessToken, loadTokens, exchangeCode, setRuntimeToken };
