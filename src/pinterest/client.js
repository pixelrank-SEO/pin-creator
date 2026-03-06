'use strict';

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { getAccessToken } = require('./auth');

const BASE_URL = process.env.PINTEREST_SANDBOX === 'true'
  ? 'https://api-sandbox.pinterest.com/v5'
  : 'https://api.pinterest.com/v5';

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Upload a local image file to Pinterest's media upload endpoint.
 * Returns the media_id to use when creating the pin.
 *
 * @param {string} filePath - Local path to the processed image
 * @returns {Promise<string>} media_id
 */
async function uploadMedia(filePath) {
  const token = await getAccessToken();

  // Step 1: Register the media upload
  const registerResponse = await axios.post(
    `${BASE_URL}/media`,
    { media_type: 'video' },  // Pinterest uses 'image' for pin image uploads
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  const { media_id, upload_url, upload_parameters } = registerResponse.data;

  // Step 2: Upload the file to the pre-signed S3 URL
  const form = new FormData();
  if (upload_parameters) {
    for (const [key, value] of Object.entries(upload_parameters)) {
      form.append(key, value);
    }
  }
  form.append('file', fs.createReadStream(filePath));

  await axios.post(upload_url, form, {
    headers: form.getHeaders(),
    timeout: 60000,
    maxContentLength: 35 * 1024 * 1024,
  });

  return media_id;
}

/**
 * Create a Pinterest pin using an image URL (simplest approach — no media upload needed).
 * Pinterest API v5 supports providing an image URL directly in the pin payload.
 *
 * @param {object} pin - Composed pin payload from composer.js
 * @param {string} pin.title
 * @param {string} pin.description
 * @param {string} pin.link
 * @param {string} pin.imageUrl
 * @param {string} pin.boardId
 * @param {string} pin.altText
 * @returns {Promise<{id, url}>}
 */
async function createPin(pin) {
  const token = await getAccessToken();

  const payload = {
    board_id: pin.boardId,
    title: pin.title,
    description: pin.description,
    link: pin.link,
    alt_text: pin.altText,
    media_source: {
      source_type: 'image_url',
      url: pin.imageUrl,
    },
  };

  const response = await axios.post(`${BASE_URL}/pins`, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return {
    id: response.data.id,
    url: `https://pinterest.com/pin/${response.data.id}/`,
  };
}

/**
 * Create a pin with automatic retry on rate-limit (429) and token refresh on 401.
 * Backs off: 1min → 5min → 15min.
 *
 * @param {object} pin
 * @returns {Promise<{id, url}>}
 */
async function createPinWithRetry(pin) {
  const backoffMinutes = [1, 5, 15];
  let attempt = 0;

  while (true) {
    try {
      return await createPin(pin);
    } catch (err) {
      const status = err.response && err.response.status;

      if (status === 429) {
        if (attempt >= backoffMinutes.length) {
          throw new Error('Pinterest rate limit exceeded after maximum retries.');
        }
        const waitMin = backoffMinutes[attempt++];
        console.warn(`  Rate limit hit (429). Waiting ${waitMin} minute(s) before retry...`);
        await sleep(waitMin * 60 * 1000);
        continue;
      }

      if (status === 401) {
        // Token expired mid-batch — force refresh and retry once
        if (attempt === 0) {
          console.warn('  Token expired (401). Refreshing and retrying...');
          attempt++;
          // getAccessToken will auto-refresh on next call
          continue;
        }
        throw new Error('Pinterest authentication failed after token refresh. Re-run: node cli.js auth login');
      }

      // Propagate all other errors
      const message = (err.response && err.response.data && JSON.stringify(err.response.data)) || err.message;
      throw new Error(`Pinterest API error (${status || 'network'}): ${message}`);
    }
  }
}

module.exports = { createPin, createPinWithRetry, uploadMedia };
