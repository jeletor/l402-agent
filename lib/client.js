'use strict';

/**
 * Parse a WWW-Authenticate header to extract L402 challenge fields.
 * Expected format: L402 invoice="lnbc...", macaroon="<hex>"
 *
 * @param {string} header - The WWW-Authenticate header value
 * @returns {{ invoice: string, macaroon: string } | null}
 */
function parseWwwAuthenticate(header) {
  if (!header || typeof header !== 'string') return null;

  const trimmed = header.trim();
  if (!trimmed.startsWith('L402 ') && !trimmed.startsWith('l402 ')) return null;

  const rest = trimmed.substring(5);

  // Extract invoice="..."
  const invoiceMatch = rest.match(/invoice="([^"]+)"/i);
  if (!invoiceMatch) return null;

  // Extract macaroon="..."
  const macaroonMatch = rest.match(/macaroon="([^"]+)"/i);
  if (!macaroonMatch) return null;

  return {
    invoice: invoiceMatch[1],
    macaroon: macaroonMatch[1]
  };
}

/**
 * L402-aware fetch that automatically handles 402 → pay → retry.
 *
 * @param {string} url - The URL to fetch
 * @param {object} [opts] - Options (superset of standard fetch options)
 * @param {object} [opts.wallet] - lightning-agent wallet instance (required for auto-pay)
 * @param {number} [opts.maxAmountSats] - Maximum amount willing to pay (safety limit)
 * @param {function} [opts.onPayment] - Callback called with { invoice, preimage, amountSats } on payment
 * @param {object} [opts.headers] - Additional request headers
 * @param {string} [opts.method] - HTTP method
 * @param {*} [opts.body] - Request body
 * @returns {Promise<Response>}
 */
async function l402Fetch(url, opts = {}) {
  const { wallet, maxAmountSats, onPayment, ...fetchOpts } = opts;

  // 1. Make the initial request
  const response = await fetch(url, fetchOpts);

  // 2. If not 402, return as-is
  if (response.status !== 402) {
    return response;
  }

  // 3. If 402 but no wallet, return the 402 response for caller to handle
  if (!wallet) {
    return response;
  }

  // 4. Parse the WWW-Authenticate header
  const wwwAuth = response.headers.get('www-authenticate');
  const challenge = parseWwwAuthenticate(wwwAuth);

  if (!challenge) {
    // Can't parse the challenge — return original response
    return response;
  }

  const { invoice, macaroon } = challenge;

  // 5. Check amount if maxAmountSats is set
  if (maxAmountSats !== undefined && maxAmountSats !== null) {
    let amountSats = null;
    try {
      // Use the wallet's decodeInvoice if available, otherwise try to decode from the response body
      if (typeof wallet.decodeInvoice === 'function') {
        const decoded = wallet.decodeInvoice(invoice);
        amountSats = decoded.amountSats;
      }
    } catch {
      // If decode fails, we can't verify amount
    }

    // Also try to get amount from the response body (JSON)
    if (amountSats === null) {
      try {
        const body = await response.clone().json();
        if (body.amountSats) amountSats = body.amountSats;
      } catch {
        // Not JSON or no amountSats field
      }
    }

    if (amountSats !== null && amountSats > maxAmountSats) {
      throw new Error(
        `L402 invoice amount (${amountSats} sats) exceeds maxAmountSats (${maxAmountSats} sats)`
      );
    }
  }

  // 6. Pay the invoice
  const payResult = await wallet.payInvoice(invoice);
  const preimage = payResult.preimage;

  if (!preimage) {
    throw new Error('L402 payment succeeded but no preimage was returned');
  }

  // 7. Call onPayment callback if provided
  if (typeof onPayment === 'function') {
    let amountSats = null;
    try {
      if (typeof wallet.decodeInvoice === 'function') {
        amountSats = wallet.decodeInvoice(invoice).amountSats;
      }
    } catch { /* best effort */ }

    onPayment({ invoice, preimage, amountSats });
  }

  // 8. Retry the original request with L402 authorization
  const retryHeaders = new Headers(fetchOpts.headers || {});
  retryHeaders.set('Authorization', `L402 ${macaroon}:${preimage}`);

  const retryOpts = {
    ...fetchOpts,
    headers: retryHeaders
  };

  return fetch(url, retryOpts);
}

module.exports = {
  l402Fetch,
  parseWwwAuthenticate
};
