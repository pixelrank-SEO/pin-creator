'use strict';

/**
 * Truncate a string at the last word boundary before maxLength.
 */
function truncateAtWord(str, maxLength) {
  if (!str || str.length <= maxLength) return str;
  const truncated = str.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Build a Pinterest-optimised description.
 * Combines the product description with optional hashtags, capped at 500 chars.
 */
function buildDescription(rawDescription, hashtags = []) {
  const MAX = 500;

  // Clean up whitespace
  let desc = (rawDescription || '').replace(/\s+/g, ' ').trim();

  // Build the hashtag string
  const tagString = hashtags.length
    ? ' ' + hashtags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ')
    : '';

  // If description + tags fit, use as-is
  if ((desc + tagString).length <= MAX) {
    return (desc + tagString).trim();
  }

  // Truncate description to leave room for tags
  const roomForDesc = MAX - tagString.length;
  if (roomForDesc > 20) {
    desc = truncateAtWord(desc, roomForDesc - 1); // -1 for safety
  } else {
    // Tags alone exceed the limit — truncate tags
    desc = truncateAtWord(desc, MAX);
    return desc;
  }

  return (desc + tagString).trim();
}

/**
 * Assemble the Pinterest pin payload from scraped product data.
 *
 * @param {object} productData - Output from a scraper
 * @param {string} productData.title
 * @param {string} productData.description
 * @param {string} productData.imageUrl
 * @param {string} affiliateUrl - User-supplied destination URL (never modified)
 * @param {string} boardId - Pinterest board ID
 * @param {string[]} [hashtags] - Optional hashtags to append to description
 * @returns {{ title, description, link, altText, imageUrl, boardId }}
 */
function composePin(productData, affiliateUrl, boardId, hashtags = []) {
  const title = truncateAtWord(productData.title, 100);
  const description = buildDescription(productData.description, hashtags);

  return {
    title,
    description,
    link: affiliateUrl,       // passed through as-is per spec
    altText: title,           // reuse title for accessibility
    imageUrl: productData.imageUrl,
    boardId,
  };
}

module.exports = { composePin, buildDescription, truncateAtWord };
