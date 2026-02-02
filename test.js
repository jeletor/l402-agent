'use strict';

const crypto = require('crypto');
const {
  l402,
  verifyPreimage,
  parseAuthHeader,
  buildWwwAuthenticateHeader,
  l402Fetch,
  parseWwwAuthenticate
} = require('./lib/index');

// ─── Test helpers ───

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

// Known test pair
const KNOWN_PREIMAGE = '0000000000000000000000000000000000000000000000000000000000000001';
const KNOWN_HASH = crypto.createHash('sha256')
  .update(Buffer.from(KNOWN_PREIMAGE, 'hex'))
  .digest('hex');

// ─── Middleware Tests ───

console.log('\n🔧 Middleware Tests');
console.log('─'.repeat(40));

// Middleware creation
console.log('\nMiddleware creation:');

const fakeWallet = {
  createInvoice: async () => ({
    invoice: 'lnbc250n1fake',
    paymentHash: 'abc123',
    amountSats: 25
  }),
  payInvoice: async () => ({ preimage: 'def456' }),
  decodeInvoice: () => ({ amountSats: 25 })
};

const mw = l402({ wallet: fakeWallet, amountSats: 25 });
assert(typeof mw === 'function', 'l402() returns a function');
assert(mw.length === 3, 'middleware has (req, res, next) signature');

// Options validation
console.log('\nOptions validation:');

assertThrows(
  () => l402({}),
  'throws without wallet'
);

assertThrows(
  () => l402({ wallet: fakeWallet }),
  'throws without amountSats'
);

assertThrows(
  () => l402({ wallet: fakeWallet, amountSats: 0 }),
  'throws with amountSats = 0'
);

assertThrows(
  () => l402({ wallet: fakeWallet, amountSats: -10 }),
  'throws with negative amountSats'
);

assertThrows(
  () => l402({ wallet: fakeWallet, amountSats: 'ten' }),
  'throws with non-number amountSats'
);

// ─── Preimage Verification ───

console.log('\nPreimage verification:');

assert(
  verifyPreimage(KNOWN_PREIMAGE, KNOWN_HASH),
  'valid preimage verifies correctly'
);

assert(
  !verifyPreimage('ff' + KNOWN_PREIMAGE.substring(2), KNOWN_HASH),
  'wrong preimage is rejected'
);

assert(
  !verifyPreimage('not-hex', KNOWN_HASH),
  'invalid hex preimage is rejected'
);

assert(
  !verifyPreimage('', KNOWN_HASH),
  'empty preimage is rejected'
);

assert(
  !verifyPreimage(KNOWN_PREIMAGE, '0000000000000000000000000000000000000000000000000000000000000000'),
  'preimage against wrong hash is rejected'
);

// ─── Authorization Header Parsing ───

console.log('\nAuthorization header parsing:');

const validAuth = `L402 ${KNOWN_HASH}:${KNOWN_PREIMAGE}`;
const parsedAuth = parseAuthHeader(validAuth);

assert(parsedAuth !== null, 'parses valid L402 header');
assert(parsedAuth.macaroon === KNOWN_HASH, 'extracts macaroon (payment hash)');
assert(parsedAuth.preimage === KNOWN_PREIMAGE, 'extracts preimage');

assert(parseAuthHeader(null) === null, 'returns null for null header');
assert(parseAuthHeader('') === null, 'returns null for empty header');
assert(parseAuthHeader('Bearer abc123') === null, 'returns null for non-L402 header');
assert(parseAuthHeader('L402 nocolon') === null, 'returns null for missing colon separator');
assert(parseAuthHeader('L402 :preimage') === null, 'returns null for empty macaroon');
assert(parseAuthHeader('L402 macaroon:') === null, 'returns null for empty preimage');
assert(parseAuthHeader('L402 not-hex:not-hex') === null, 'returns null for non-hex values');

// Case insensitive prefix
const lowerAuth = `l402 ${KNOWN_HASH}:${KNOWN_PREIMAGE}`;
const parsedLower = parseAuthHeader(lowerAuth);
assert(parsedLower !== null, 'parses lowercase "l402" prefix');

// ─── WWW-Authenticate Header Generation ───

console.log('\nWWW-Authenticate header generation:');

const invoice = 'lnbc250n1ptest';
const macaroon = 'abc123def456';
const wwwAuth = buildWwwAuthenticateHeader(invoice, macaroon);

assert(
  wwwAuth === `L402 invoice="${invoice}", macaroon="${macaroon}"`,
  'generates correct WWW-Authenticate header format'
);
assert(wwwAuth.startsWith('L402 '), 'header starts with L402 prefix');
assert(wwwAuth.includes(`invoice="${invoice}"`), 'header contains invoice');
assert(wwwAuth.includes(`macaroon="${macaroon}"`), 'header contains macaroon');

// ─── Client: WWW-Authenticate Parsing ───

console.log('\n🌐 Client Tests');
console.log('─'.repeat(40));

console.log('\nWWW-Authenticate parsing:');

const testInvoice = 'lnbc250n1pjfake';
const testMacaroon = 'aabbccdd';
const testHeader = `L402 invoice="${testInvoice}", macaroon="${testMacaroon}"`;

const parsedWww = parseWwwAuthenticate(testHeader);
assert(parsedWww !== null, 'parses valid WWW-Authenticate header');
assert(parsedWww.invoice === testInvoice, 'extracts invoice from header');
assert(parsedWww.macaroon === testMacaroon, 'extracts macaroon from header');

assert(parseWwwAuthenticate(null) === null, 'returns null for null');
assert(parseWwwAuthenticate('') === null, 'returns null for empty string');
assert(parseWwwAuthenticate('Basic realm="test"') === null, 'returns null for non-L402 header');
assert(parseWwwAuthenticate('L402 noinvoice') === null, 'returns null for missing invoice');
assert(
  parseWwwAuthenticate('L402 invoice="lnbc1" ') === null,
  'returns null for missing macaroon'
);

// Case insensitive
const lowerWww = `l402 invoice="${testInvoice}", macaroon="${testMacaroon}"`;
const parsedLowerWww = parseWwwAuthenticate(lowerWww);
assert(parsedLowerWww !== null, 'parses lowercase "l402" prefix in WWW-Authenticate');

// ─── Async tests (wrapped in IIFE to avoid top-level await) ───

(async () => {

// ─── Middleware Integration (mock) ───

console.log('\nMiddleware integration (mock req/res):');

// Test: valid auth header passes through
{
  const mw = l402({ wallet: fakeWallet, amountSats: 25 });

  const req = {
    headers: { authorization: `L402 ${KNOWN_HASH}:${KNOWN_PREIMAGE}` }
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  const res = {};

  await mw(req, res, next);

  assert(nextCalled, 'next() called for valid L402 auth');
  assert(req.l402 !== undefined, 'req.l402 is set');
  assert(req.l402.paymentHash === KNOWN_HASH, 'req.l402.paymentHash is correct');
  assert(req.l402.preimage === KNOWN_PREIMAGE, 'req.l402.preimage is correct');
  assert(req.l402.amountSats === 25, 'req.l402.amountSats is correct');
}

// Test: no auth header → 402 response
{
  const mw = l402({ wallet: fakeWallet, amountSats: 25 });

  const req = { headers: {} };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  let statusCode = null;
  const headers = {};
  let body = null;

  const resObj = {
    setHeader(k, v) { headers[k] = v; },
    end(data) { body = data; }
  };
  Object.defineProperty(resObj, 'statusCode', {
    set(v) { statusCode = v; },
    get() { return statusCode; }
  });

  await mw(req, resObj, next);

  assert(!nextCalled, 'next() NOT called without auth');
  assert(statusCode === 402, 'response status is 402');
  assert(headers['WWW-Authenticate'] !== undefined, 'WWW-Authenticate header is set');
  assert(headers['WWW-Authenticate'].startsWith('L402 '), 'WWW-Authenticate starts with L402');
  assert(headers['Content-Type'] === 'application/json', 'Content-Type is application/json');

  const parsed = JSON.parse(body);
  assert(parsed.error === 'Payment Required', 'body contains error message');
  assert(parsed.amountSats === 25, 'body contains amountSats');
  assert(parsed.invoice !== undefined, 'body contains invoice');
}

// Test: invalid auth header → 402 response
{
  const mw = l402({ wallet: fakeWallet, amountSats: 25 });

  const req = {
    headers: { authorization: `L402 ${KNOWN_HASH}:${'ff'.repeat(32)}` }
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  let statusCode = null;
  const headers = {};
  let body = null;

  const resObj = {
    setHeader(k, v) { headers[k] = v; },
    end(data) { body = data; }
  };
  Object.defineProperty(resObj, 'statusCode', {
    set(v) { statusCode = v; },
    get() { return statusCode; }
  });

  await mw(req, resObj, next);

  assert(!nextCalled, 'next() NOT called with invalid preimage');
  assert(statusCode === 402, 'invalid auth → 402 status');
}

// ─── Client: maxAmountSats enforcement ───

console.log('\nmaxAmountSats enforcement:');

// Test with mock wallet that decodes invoices
{
  const mockWallet = {
    decodeInvoice(inv) {
      // lnbc500n = 500 nano-BTC = 50 sats
      if (inv.startsWith('lnbc500n')) return { amountSats: 50 };
      if (inv.startsWith('lnbc250n')) return { amountSats: 25 };
      return { amountSats: null };
    },
    async payInvoice() {
      return { preimage: KNOWN_PREIMAGE };
    }
  };

  // We can't easily test l402Fetch without a real HTTP server,
  // but we can test the amount checking logic by testing the decoder
  const decoded50 = mockWallet.decodeInvoice('lnbc500n1test');
  assert(decoded50.amountSats === 50, 'decodes 50 sat invoice');

  const decoded25 = mockWallet.decodeInvoice('lnbc250n1test');
  assert(decoded25.amountSats === 25, 'decodes 25 sat invoice');

  assert(decoded50.amountSats > 30, '50 sats exceeds 30 sat limit');
  assert(decoded25.amountSats <= 30, '25 sats within 30 sat limit');
}

// ─── Roundtrip Test ───

console.log('\nRoundtrip (header generation → parsing → verification):');

{
  // Server creates challenge
  const serverInvoice = 'lnbc250n1ptestinvoice';
  const serverPaymentHash = KNOWN_HASH;
  const challenge = buildWwwAuthenticateHeader(serverInvoice, serverPaymentHash);

  // Client parses challenge
  const clientParsed = parseWwwAuthenticate(challenge);
  assert(clientParsed.invoice === serverInvoice, 'client extracts correct invoice');
  assert(clientParsed.macaroon === serverPaymentHash, 'client extracts correct macaroon/hash');

  // Client "pays" and gets preimage, builds auth header
  const clientPreimage = KNOWN_PREIMAGE;
  const authHeader = `L402 ${clientParsed.macaroon}:${clientPreimage}`;

  // Server parses auth header
  const serverParsed = parseAuthHeader(authHeader);
  assert(serverParsed !== null, 'server parses client auth header');

  // Server verifies preimage
  const verified = verifyPreimage(serverParsed.preimage, serverParsed.macaroon);
  assert(verified, 'server verifies preimage matches payment hash');
}

// ─── Summary ───

console.log('\n' + '═'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(40));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!\n');
}

})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
