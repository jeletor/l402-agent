'use strict';

const crypto = require('crypto');

/**
 * Verify that a preimage (hex) hashes to the expected payment hash (hex).
 * @param {string} preimage - Hex-encoded preimage
 * @param {string} paymentHash - Hex-encoded expected payment hash
 * @returns {boolean}
 */
function verifyPreimage(preimage, paymentHash) {
  try {
    const hash = crypto.createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    return hash === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Parse an L402 Authorization header.
 * Expected format: "L402 <macaroon>:<preimage>"
 * In our simplified scheme, macaroon = payment hash (hex).
 *
 * @param {string} header - The Authorization header value
 * @returns {{ macaroon: string, preimage: string } | null}
 */
function parseAuthHeader(header) {
  if (!header || typeof header !== 'string') return null;

  const trimmed = header.trim();
  if (!trimmed.startsWith('L402 ') && !trimmed.startsWith('l402 ')) return null;

  const token = trimmed.substring(5).trim();
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return null;

  const macaroon = token.substring(0, colonIdx);
  const preimage = token.substring(colonIdx + 1);

  // Basic hex validation
  if (!macaroon || !preimage) return null;
  if (!/^[0-9a-fA-F]+$/.test(macaroon)) return null;
  if (!/^[0-9a-fA-F]+$/.test(preimage)) return null;

  return { macaroon, preimage };
}

/**
 * Build the WWW-Authenticate header value for a 402 response.
 * @param {string} invoice - Bolt11 invoice string
 * @param {string} macaroon - Macaroon token (payment hash hex in our scheme)
 * @returns {string}
 */
function buildWwwAuthenticateHeader(invoice, macaroon) {
  return `L402 invoice="${invoice}", macaroon="${macaroon}"`;
}

/**
 * Create L402 paywall middleware.
 *
 * @param {object} opts
 * @param {object} opts.wallet - lightning-agent wallet instance (must have createInvoice)
 * @param {number} opts.amountSats - Price in satoshis
 * @param {string} [opts.description] - Invoice description
 * @param {number} [opts.expirySeconds=600] - Invoice expiry in seconds (default 10 min)
 * @returns {function} Connect-compatible middleware (req, res, next)
 */
function l402(opts = {}) {
  if (!opts.wallet) {
    throw new Error('l402 middleware requires a wallet option');
  }
  if (!opts.amountSats || typeof opts.amountSats !== 'number' || opts.amountSats <= 0) {
    throw new Error('l402 middleware requires a positive amountSats option');
  }

  const { wallet, amountSats, description, expirySeconds = 600 } = opts;

  // In-memory store of issued payment hashes
  const pendingHashes = new Map();

  return async function l402Middleware(req, res, next) {
    // 1. Check for Authorization header
    const authHeader = req.headers && req.headers['authorization'];
    const parsed = parseAuthHeader(authHeader);

    if (parsed) {
      const { macaroon, preimage } = parsed;
      const paymentHash = macaroon.toLowerCase();

      // 2. Verify the preimage matches the payment hash
      if (verifyPreimage(preimage, paymentHash)) {
        // Attach L402 info to request
        req.l402 = {
          paymentHash,
          preimage: preimage.toLowerCase(),
          amountSats
        };
        return next();
      }

      // Invalid preimage — fall through to issue a new challenge
    }

    // 3. No valid auth — create an invoice and respond with 402
    try {
      const invoiceResult = await wallet.createInvoice({
        amountSats,
        description: description || `L402 payment: ${amountSats} sats`,
        expiry: expirySeconds
      });

      const { invoice, paymentHash } = invoiceResult;

      // Store as pending
      pendingHashes.set(paymentHash, {
        invoice,
        amountSats,
        createdAt: Date.now(),
        expiryMs: expirySeconds * 1000
      });

      // Clean up expired entries periodically
      if (pendingHashes.size > 100) {
        const now = Date.now();
        for (const [hash, entry] of pendingHashes) {
          if (now - entry.createdAt > entry.expiryMs) {
            pendingHashes.delete(hash);
          }
        }
      }

      // The macaroon in our simplified scheme IS the payment hash
      const wwwAuth = buildWwwAuthenticateHeader(invoice, paymentHash);

      res.statusCode = 402;
      res.setHeader('WWW-Authenticate', wwwAuth);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Payment Required',
        amountSats,
        description: description || `L402 payment: ${amountSats} sats`,
        invoice,
        paymentHash
      }));
    } catch (err) {
      // If invoice creation fails, return 500
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Failed to create invoice',
        message: err.message
      }));
    }
  };
}

module.exports = {
  l402,
  verifyPreimage,
  parseAuthHeader,
  buildWwwAuthenticateHeader
};
