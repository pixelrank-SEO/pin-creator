'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Attempt 1: JSON-LD schema.org/Product
 */
function extractFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    try {
      const data = JSON.parse($(script).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const type = item['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
          const imageUrl =
            (Array.isArray(item.image) ? item.image[0] : item.image) ||
            (item.image && item.image.url) ||
            null;
          return {
            title: item.name || null,
            description: item.description || null,
            imageUrl: typeof imageUrl === 'string' ? imageUrl : (imageUrl && imageUrl.url) || null,
          };
        }
      }
    } catch (_) { /* malformed JSON-LD — skip */ }
  }
  return null;
}

/**
 * Attempt 2: Open Graph meta tags
 */
function extractFromOpenGraph($) {
  const title = $('meta[property="og:title"]').attr('content') || null;
  const description = $('meta[property="og:description"]').attr('content') || null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;

  if (title || imageUrl) {
    return { title, description, imageUrl };
  }
  return null;
}

/**
 * Attempt 3: HTML heuristics
 * - Title from first <h1>
 * - Image: largest <img> near a <h1> (by width*height attributes, fallback to first large img)
 * - Description: first <p> after a heading
 */
function extractFromHeuristics($) {
  const title = $('h1').first().text().trim() || $('title').text().trim() || null;

  // Find the largest image by dimensions (if provided in attributes)
  let bestImg = null;
  let bestArea = 0;
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || src.startsWith('data:')) return;
    const w = parseInt($(el).attr('width') || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      bestImg = src;
    }
  });
  // If no dimensions found, just take first substantial img
  if (!bestImg) {
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.startsWith('data:') && (src.endsWith('.jpg') || src.endsWith('.jpeg') || src.endsWith('.png') || src.endsWith('.webp'))) {
        bestImg = src;
        return false; // break
      }
    });
  }

  // First <p> after the first heading
  let description = null;
  const h1 = $('h1').first();
  if (h1.length) {
    const nextP = h1.nextAll('p').first().text().trim();
    if (nextP) description = nextP;
  }
  if (!description) {
    description = $('p').first().text().trim() || null;
  }

  if (title || bestImg) {
    return { title, description, imageUrl: bestImg };
  }
  return null;
}

/**
 * Resolve a potentially relative image URL to absolute.
 */
function resolveImageUrl(imageUrl, pageUrl) {
  if (!imageUrl) return null;
  try {
    return new URL(imageUrl, pageUrl).href;
  } catch (_) {
    return imageUrl;
  }
}

/**
 * Main generic scraper — tries JSON-LD → OG tags → HTML heuristics.
 * @param {string} url
 * @param {object} options
 * @param {string} [options.proxy]
 * @returns {Promise<{title, description, imageUrl, sourceUrl}>}
 */
async function scrapeGeneric(url, options = {}) {
  const axiosConfig = {
    headers: {
      'User-Agent': randomUserAgent(),
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
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

  let result =
    extractFromJsonLd($) ||
    extractFromOpenGraph($) ||
    extractFromHeuristics($);

  if (!result) {
    throw new Error('Could not extract product data from the page. All extraction methods failed.');
  }

  // Resolve relative image URLs
  result.imageUrl = resolveImageUrl(result.imageUrl, url);

  if (!result.title) throw new Error('Could not extract product title from page.');
  if (!result.imageUrl) throw new Error('Could not extract product image from page.');

  return {
    title: result.title,
    description: result.description || '',
    imageUrl: result.imageUrl,
    sourceUrl: url,
  };
}

module.exports = { scrapeGeneric };
