#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Command } = require('commander');
const fs = require('fs');
const path = require('path');

const { scrapeAmazon, extractAsin } = require('./src/scrapers/amazon');
const { scrapeGeneric } = require('./src/scrapers/generic');
const { composePin } = require('./src/composer');
const { downloadAndResize } = require('./src/image/processor');
const { login } = require('./src/pinterest/auth');
const { listBoards, findBoard } = require('./src/pinterest/boards');
const { createPinWithRetry } = require('./src/pinterest/client');
const { logger, logSuccess, logFailure } = require('./src/logger');
const { polishPin } = require('./src/ai/polish');

const program = new Command();

program
  .name('pin-creator')
  .description('Pinterest Auto Poster — product URL → Pinterest pin')
  .version('1.0.0');

// ─────────────────────────────────────────────
// auth login
// ─────────────────────────────────────────────
program
  .command('auth')
  .description('Manage Pinterest authentication')
  .addCommand(
    new Command('login')
      .description('Authenticate with Pinterest via OAuth 2.0')
      .action(async () => {
        try {
          await login();
        } catch (err) {
          logger.error(err.message);
          process.exit(1);
        }
      })
  );

// ─────────────────────────────────────────────
// boards
// ─────────────────────────────────────────────
program
  .command('boards')
  .description('List your Pinterest boards')
  .action(async () => {
    try {
      console.log('\nFetching your Pinterest boards...\n');
      const boards = await listBoards();
      if (!boards.length) {
        console.log('No boards found.');
        return;
      }
      const divider = '─'.repeat(60);
      console.log(divider);
      console.log(`  ${'Board Name'.padEnd(35)} ${'ID'.padEnd(20)} Pins`);
      console.log(divider);
      for (const b of boards) {
        console.log(`  ${b.name.padEnd(35)} ${b.id.padEnd(20)} ${b.pinCount}`);
      }
      console.log(divider + '\n');
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// post
// ─────────────────────────────────────────────
program
  .command('post')
  .description('Scrape a product URL and create a Pinterest pin')
  .requiredOption('-u, --url <url>', 'Product page URL (Amazon or generic)')
  .requiredOption('-a, --affiliate-url <url>', 'Affiliate/tracking URL (becomes the pin link)')
  .option('-b, --board <name|id>', 'Pinterest board name or ID', process.env.DEFAULT_BOARD_ID || '')
  .option('--hashtags <tags>', 'Comma-separated hashtags to append to description', '')
  .option('--dry-run', 'Preview the pin without posting to Pinterest')
  .option('--ai', 'Use Claude AI to polish the pin title and description')
  .option('--delay <ms>', 'Delay in ms before scraping', String(process.env.REQUEST_DELAY_MS || '2000'))
  .action(async (opts) => {
    try {
      await postPin({
        url: opts.url,
        affiliateUrl: opts.affiliateUrl,
        board: opts.board,
        hashtags: opts.hashtags ? opts.hashtags.split(',').map(t => t.trim()).filter(Boolean) : [],
        dryRun: opts.dryRun,
        aiPolish: opts.ai,
        delay: parseInt(opts.delay, 10),
      });
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// batch
// ─────────────────────────────────────────────
program
  .command('batch')
  .description('Post multiple pins from a CSV file')
  .requiredOption('-i, --input <file>', 'Path to CSV file (product_url,affiliate_url,board_name)')
  .option('--delay <ms>', 'Delay between pins in ms', String(process.env.PIN_DELAY_MS || '12000'))
  .option('--dry-run', 'Preview all pins without posting')
  .option('--ai', 'Use Claude AI to polish each pin title and description')
  .action(async (opts) => {
    const rows = parseCSV(opts.input);
    if (!rows.length) {
      logger.error('No rows found in CSV.');
      process.exit(1);
    }

    const pinDelay = parseInt(opts.delay, 10);
    console.log(`\nBatch mode: ${rows.length} URL(s) — ${pinDelay / 1000}s delay between posts\n`);

    let success = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`[${i + 1}/${rows.length}] ${row.product_url}`);
      try {
        await postPin({
          url: row.product_url,
          affiliateUrl: row.affiliate_url,
          board: row.board_name || process.env.DEFAULT_BOARD_ID || '',
          hashtags: [],
          dryRun: opts.dryRun,
          aiPolish: opts.ai,
          delay: parseInt(process.env.REQUEST_DELAY_MS || '2000', 10),
        });
        success++;
      } catch (err) {
        logger.error(`  Skipped: ${err.message}`);
        logFailure({ url: row.product_url, affiliateUrl: row.affiliate_url, error: err.message });
        failed++;
      }

      // Inter-pin delay (skip after last item)
      if (!opts.dryRun && i < rows.length - 1) {
        console.log(`  Waiting ${pinDelay / 1000}s before next pin...`);
        await sleep(pinDelay);
      }
    }

    console.log(`\nBatch complete: ${success} succeeded, ${failed} failed.`);
    console.log(`Log saved to: logs/pins.csv\n`);
  });

// ─────────────────────────────────────────────
// Core: scrape + compose + post
// ─────────────────────────────────────────────
async function postPin({ url, affiliateUrl, board, hashtags, dryRun, aiPolish, delay }) {
  if (delay > 0) await sleep(delay);

  // 1. Scrape
  console.log(`  Scraping product data...`);
  const productData = await scrapeUrl(url);
  console.log(`  Title: ${productData.title.slice(0, 60)}${productData.title.length > 60 ? '…' : ''}`);

  // 1b. AI polish (optional)
  if (aiPolish) {
    console.log(`  Polishing with AI...`);
    try {
      const polished = await polishPin(productData, hashtags);
      productData.title = polished.title;
      productData.description = polished.description;
      hashtags = []; // already embedded by polishPin
      console.log(`  AI title: ${polished.title.slice(0, 60)}${polished.title.length > 60 ? '…' : ''}`);
    } catch (err) {
      logger.warn(`  AI polish failed (using original): ${err.message}`);
    }
  }

  // 2. Resolve board ID
  let boardId = board;
  if (!dryRun && boardId) {
    const resolved = await findBoard(boardId);
    if (!resolved) {
      throw new Error(`Board "${boardId}" not found. Run: node cli.js boards`);
    }
    boardId = resolved.id;
    console.log(`  Board: ${resolved.name} (${resolved.id})`);
  }

  // 3. Compose pin
  const pin = composePin(productData, affiliateUrl, boardId || 'DRY_RUN_BOARD', hashtags);

  if (dryRun) {
    printPinPreview(pin, productData);
    return;
  }

  // 4. Post to Pinterest (image URL approach — no local download needed for API v5)
  console.log(`  Posting to Pinterest...`);
  const result = await createPinWithRetry(pin);
  console.log(`  Posted: ${result.url}`);

  logSuccess({ url, affiliateUrl, pinId: result.id, pinUrl: result.url });
  return result;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function scrapeUrl(url) {
  const isAmazon = /amazon\.(com|co\.uk|de|fr|ca|com\.au|in|co\.jp)/i.test(url)
    || /amzn\.to\//i.test(url)
    || /amzn\.eu\//i.test(url)
    || extractAsin(url);
  if (isAmazon) {
    logger.info('Detected: Amazon product page');
    return scrapeAmazon(url);
  }
  logger.info('Detected: Generic product page');
  return scrapeGeneric(url);
}

function printPinPreview(pin, productData) {
  const divider = '─'.repeat(60);
  console.log(`\n${divider}`);
  console.log('  PIN PREVIEW (dry-run — nothing posted)');
  console.log(divider);
  console.log(`  Title        : ${pin.title}`);
  console.log(`  Description  : ${pin.description}`);
  console.log(`  Link         : ${pin.link}`);
  console.log(`  Image URL    : ${pin.imageUrl}`);
  console.log(`  Board ID     : ${pin.boardId}`);
  console.log(`  Alt Text     : ${pin.altText}`);
  if (productData.asin) console.log(`  ASIN         : ${productData.asin}`);
  if (productData.price) console.log(`  Price        : ${productData.price}`);
  console.log(divider);
  console.log(`  Title length      : ${pin.title.length} / 100 chars`);
  console.log(`  Description length: ${pin.description.length} / 500 chars`);
  console.log(divider + '\n');
}

function parseCSV(filePath) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`CSV file not found: ${fullPath}`);
  }
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(l => l.trim());
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas inside
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

// ─────────────────────────────────────────────
// web
// ─────────────────────────────────────────────
program
  .command('web')
  .description('Launch the Web UI (http://localhost:4000)')
  .option('-p, --port <port>', 'Port to listen on', '4000')
  .action((opts) => {
    process.env.PORT = opts.port;
    require('./server');
  });

program.parse(process.argv);
