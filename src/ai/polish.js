'use strict';

const OpenAI = require('openai');

let _client = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in .env');
  }
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Use GPT-4o-mini to rewrite a pin title and description for Pinterest engagement.
 *
 * @param {{ title: string, description: string, price?: string }} productData
 * @param {string[]} hashtags
 * @returns {Promise<{ title: string, description: string }>}
 */
async function polishPin(productData, hashtags = []) {
  const client = getClient();

  const hashtagStr = hashtags.length
    ? hashtags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ')
    : '';

  const priceHint = productData.price ? ` The product price is ${productData.price}.` : '';

  const prompt = `You are a Pinterest marketing expert. Rewrite the following product title and description to be engaging, benefit-focused, and optimised for Pinterest discovery.

Rules:
- Title: max 100 characters, punchy and compelling, no hashtags
- Description: max ${hashtagStr ? 450 : 500} characters, natural tone, highlight key benefits, include a subtle call-to-action
- Do NOT include hashtags in the description (they will be appended separately)
- Do NOT invent features or prices not mentioned in the original
- Return ONLY valid JSON with keys "title" and "description", nothing else${priceHint}

Original title: ${productData.title}
Original description: ${productData.description || '(none)'}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.choices[0].message.content.trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed.title || !parsed.description) {
    throw new Error('AI response missing title or description fields');
  }

  // Enforce hard limits as a safety net
  let title = parsed.title.slice(0, 100);
  let description = parsed.description.slice(0, hashtagStr ? 450 : 500);

  // Append hashtags if provided
  if (hashtagStr) {
    description = (description + ' ' + hashtagStr).trim().slice(0, 500);
  }

  return { title, description };
}

module.exports = { polishPin };
