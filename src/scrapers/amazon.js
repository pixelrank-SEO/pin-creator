'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

// Rotate through common desktop User-Agents to reduce bot detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Extract ASIN from an Amazon URL.
 * Handles formats like /dp/ASIN, /gp/product/ASIN, /ASIN
 */
function extractAsin(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/,
    /\/gp\/product\/([A-Z0-9]{10})/,
    /\/product\/([A-Z0-9]{10})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Extract the highest-resolution image URL from Amazon's image data.
 * Amazon stores image variants in a JSON blob inside the page.
 */
function extractHighResImage($, url) {
  // Try to pull the colorImages data blob which has the highest-res URLs
  const scripts = $('script').toArray();
  for (const script of scripts) {
    const text = $(script).html() || '';
    const match = text.match(/'colorImages'\s*:\s*\{[^}]*'initial'\s*:\s*(\[[\s\S]*?\])\s*\}/);
    if (match) {
      try {
        const images = JSON.parse(match[1]);
        const first = images[0];
        // Prefer hiRes, fall back to large
        if (first && (first.hiRes || first.large)) {
          return first.hiRes || first.large;
        }
      } catch (_) { /* ignore parse errors */ }
    }
  }

  // Fallback: #landingImage data-old-hires or src
  const landing = $('#landingImage');
  if (landing.length) {
    return landing.attr('data-old-hires') || landing.attr('src') || null;
  }

  // Fallback: first img inside #imgTagWrapperId
  const wrapper = $('#imgTagWrapperId img');
  if (wrapper.length) return wrapper.first().attr('src') || null;

  // Last resort: og:image
  return $('meta[property="og:image"]').attr('content') || null;
}

/**
 * Extract product title.
 */
function extractTitle($) {
  const selectors = ['#productTitle', 'h1.a-size-large', 'h1'];
  for (const sel of selectors) {
    const text = $(sel).first().text().trim();
    if (text) return text;
  }
  return $('meta[property="og:title"]').attr('content') || null;
}

/**
 * Extract bullet-point description, falling back to product description paragraph.
 */
function extractDescription($) {
  // Bullet points
  const bullets = [];
  $('#feature-bullets ul li span.a-list-item').each((_, el) => {
    const text = $(el).text().trim();
    if (text && !text.toLowerCase().includes('make sure this fits')) {
      bullets.push(text);
    }
  });
  if (bullets.length) return bullets.join(' ');

  // Product description paragraph
  const desc = $('#productDescription p').first().text().trim();
  if (desc) return desc;

  // og:description fallback
  return $('meta[property="og:description"]').attr('content') || null;
}

/**
 * Main Amazon scraper.
 * @param {string} url - Amazon product URL
 * @param {object} options
 * @param {string} [options.proxy] - Optional proxy URL
 * @returns {Promise<{asin, title, description, imageUrl, price, sourceUrl}>}
 */
async function scrapeAmazon(url, options = {}) {
  const asin = extractAsin(url);

  const axiosConfig = {
    headers: {
      'User-Agent': randomUserAgent(),
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    timeout: 15000,
    maxRedirects: 5,
  };

  if (options.proxy) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    axiosConfig.httpsAgent = new HttpsProxyAgent(options.proxy);
  }

  const response = await axios.get(url, axiosConfig);
  const $ = cheerio.load(response.data);

  // Detect CAPTCHA / robot check page
  const bodyText = $('body').text().toLowerCase();
  if (bodyText.includes('enter the characters you see below') || bodyText.includes('robot check')) {
    throw new Error('Amazon returned a CAPTCHA page. Try using --playwright mode or a proxy.');
  }

  const title = extractTitle($);
  const description = extractDescription($);
  const imageUrl = extractHighResImage($, url);

  // Price (informational only — not used in pin)
  const price =
    $('.a-price .a-offscreen').first().text().trim() ||
    $('#priceblock_ourprice').text().trim() ||
    null;

  if (!title) throw new Error('Could not extract product title from Amazon page.');
  if (!imageUrl) throw new Error('Could not extract product image from Amazon page.');

  return {
    asin,
    title,
    description: description || '',
    imageUrl,
    price,
    sourceUrl: url,
  };
}

module.exports = { scrapeAmazon, extractAsin };
