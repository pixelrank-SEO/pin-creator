'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

const LOGS_DIR = path.join(process.cwd(), 'logs');
const CSV_FILE = path.join(LOGS_DIR, 'pins.csv');
const CSV_HEADER = 'timestamp,url,affiliate_url,status,pin_id,pin_url,error\n';

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}
  }
}

function ensureCsvHeader() {
  ensureLogsDir();
  if (!fs.existsSync(CSV_FILE)) {
    try { fs.writeFileSync(CSV_FILE, CSV_HEADER, 'utf8'); } catch (_) {}
  }
}

// Winston logger for console output
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.colorize(),
    format.printf(({ level, message }) => `${level}: ${message}`)
  ),
  transports: [new transports.Console()],
});

/**
 * Append a result row to the CSV log.
 */
function logToCsv({ url, affiliateUrl, status, pinId, pinUrl, error }) {
  ensureCsvHeader();
  const timestamp = new Date().toISOString();
  const escape = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
  const row = [
    escape(timestamp),
    escape(url),
    escape(affiliateUrl),
    escape(status),
    escape(pinId || ''),
    escape(pinUrl || ''),
    escape(error || ''),
  ].join(',') + '\n';

  try { fs.appendFileSync(CSV_FILE, row, 'utf8'); } catch (_) {}
}

/**
 * Log a successful pin posting.
 */
function logSuccess({ url, affiliateUrl, pinId, pinUrl }) {
  logger.info(`Pin created: ${pinUrl}`);
  logToCsv({ url, affiliateUrl, status: 'success', pinId, pinUrl });
}

/**
 * Log a failure.
 */
function logFailure({ url, affiliateUrl, error }) {
  logger.error(`Failed [${url}]: ${error}`);
  logToCsv({ url, affiliateUrl, status: 'failed', error });
}

module.exports = { logger, logSuccess, logFailure };
