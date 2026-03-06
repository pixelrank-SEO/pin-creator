'use strict';

const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const TMP_DIR = path.join(process.cwd(), 'tmp');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/**
 * Download an image and resize it to Pinterest's optimal 1000×1500 (2:3) format.
 * Returns the local file path of the processed image.
 *
 * @param {string} imageUrl - Remote image URL
 * @param {string} filename - Output filename (without extension)
 * @returns {Promise<string>} Local file path
 */
async function downloadAndResize(imageUrl, filename = 'product') {
  ensureTmpDir();

  const outputPath = path.join(TMP_DIR, `${filename}.jpg`);

  // Download as a stream
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    maxRedirects: 5,
  });

  const buffer = Buffer.from(response.data);

  // Resize to 1000×1500, contain within bounds (pad if needed), convert to JPEG
  await sharp(buffer)
    .resize(1000, 1500, {
      fit: 'contain',          // preserve aspect ratio, pad to fill
      background: { r: 255, g: 255, b: 255, alpha: 1 }, // white padding
    })
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(outputPath);

  // Verify file size ≤ 32 MB
  const stats = fs.statSync(outputPath);
  const sizeMB = stats.size / (1024 * 1024);
  if (sizeMB > 32) {
    throw new Error(`Processed image is ${sizeMB.toFixed(1)} MB — exceeds Pinterest's 32 MB limit.`);
  }

  return outputPath;
}

/**
 * Clean up the tmp directory.
 */
function cleanTmp() {
  if (fs.existsSync(TMP_DIR)) {
    fs.readdirSync(TMP_DIR).forEach(file => {
      fs.unlinkSync(path.join(TMP_DIR, file));
    });
  }
}

module.exports = { downloadAndResize, cleanTmp };
