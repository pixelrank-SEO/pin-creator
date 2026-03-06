'use strict';

const axios = require('axios');
const { getAccessToken } = require('./auth');

const BASE_URL = process.env.PINTEREST_SANDBOX === 'true'
  ? 'https://api-sandbox.pinterest.com/v5'
  : 'https://api.pinterest.com/v5';

/**
 * Fetch all boards for the authenticated user.
 * Handles pagination automatically.
 * @returns {Promise<Array<{id, name, description, pinCount}>>}
 */
async function listBoards() {
  const token = await getAccessToken();
  const boards = [];
  let bookmark = null;

  do {
    const params = { page_size: 25 };
    if (bookmark) params.bookmark = bookmark;

    const response = await axios.get(`${BASE_URL}/boards`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 10000,
    });

    const data = response.data;
    if (data.items) {
      for (const board of data.items) {
        boards.push({
          id: board.id,
          name: board.name,
          description: board.description || '',
          pinCount: board.pin_count || 0,
        });
      }
    }

    bookmark = data.bookmark || null;
  } while (bookmark);

  return boards;
}

/**
 * Find a board by name (case-insensitive) or by ID.
 * @param {string} nameOrId
 * @returns {Promise<{id, name} | null>}
 */
async function findBoard(nameOrId) {
  const boards = await listBoards();
  const match = boards.find(
    b => b.id === nameOrId || b.name.toLowerCase() === nameOrId.toLowerCase()
  );
  return match || null;
}

module.exports = { listBoards, findBoard };
