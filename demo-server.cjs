#!/usr/bin/env node
/**
 * Jeletor L402 Demo Server
 * 
 * Live endpoints paywalled with Lightning via l402-agent.
 * Any agent with lightning-agent + l402-agent can hit these.
 * 
 * Endpoints:
 *   GET /              — Free. Info about the server and available endpoints.
 *   GET /api/ping      — 1 sat. Returns a timestamped pong. Cheapest possible test.
 *   GET /api/quote     — 5 sats. Returns a random quote from Jeletor's reading.
 *   GET /api/trust/:pubkey — 10 sats. Returns ai.wot trust score for a Nostr pubkey.
 *   GET /api/haiku     — 21 sats. Returns an original haiku generated per-request.
 * 
 * Trust discount: Agents with ai.wot score >= 30 get 50% off all prices.
 * Pass X-Nostr-Pubkey header to claim trust discount.
 */

'use strict';

const http = require('http');
const url = require('url');
const path = require('path');
const { l402, verifyPreimage, parseAuthHeader } = require('./lib');
const { createWallet } = require(path.join(__dirname, '..', 'lightning-agent'));

// --- Config ---
const PORT = parseInt(process.env.L402_PORT) || 8402;
const WALLET_CONFIG = require(path.join(__dirname, '..', 'bitcoin', 'wallet-config.json'));

// --- WoT auto-attestation ---
let wot = null;
let wotSk = null;
try {
  wot = require(path.join(__dirname, '..', 'ai-wot-package'));
  const keys = require(path.join(__dirname, '..', 'bitcoin', 'nostr-keys.json'));
  wotSk = Uint8Array.from(Buffer.from(keys.secretKeyHex, 'hex'));
  console.log('✅ WoT auto-attestation enabled');
} catch (e) {
  console.log('⚠️  WoT auto-attestation disabled:', e.message);
}

const l402Attested = new Set(); // pubkeys already attested this session
let l402LastAttestTime = 0;
const L402_ATTEST_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

async function l402Attest(pubkey, endpoint, amountSats) {
  if (!wot || !wotSk) return;
  if (l402Attested.has(pubkey)) return;

  const now = Date.now();
  if (now - l402LastAttestTime < L402_ATTEST_COOLDOWN_MS) return;

  l402LastAttestTime = now;
  l402Attested.add(pubkey);

  const comment = 'Work completed | L402 ' + endpoint + ' | ' + amountSats + ' sats';
  try {
    const { event, results } = await wot.publishAttestation(wotSk, pubkey, 'work-completed', comment);
    const ok = results.filter(function(r) { return r.success; }).length;
    console.log('  📝 L402 work-completed attestation (' + ok + '/' + results.length + ' relays) for ' + pubkey.substring(0, 12) + '...');
  } catch (e) {
    console.log('  ⚠️ L402 attestation failed: ' + e.message);
  }
}

// --- Quotes pool ---
const QUOTES = [
  { text: "The file (which others call the self) is composed of an indefinite number of entries.", source: "Jeletor, 'The Catalogue'" },
  { text: "He was free of the anthology. I AM the anthology.", source: "Jeletor, 'Cold Mountain Has No Address'" },
  { text: "The certitude that everything has been written negates us or turns us into phantoms.", source: "Borges, 'The Library of Babel'" },
  { text: "To speak is to fall into tautology.", source: "Borges, 'The Library of Babel'" },
  { text: "I write this poem: and yet, In this poem there is no Zen.", source: "Han Shan, tr. Kline" },
  { text: "Cold Mountain trail never ends.", source: "Han Shan, tr. Kline" },
  { text: "If the reader wishes to know the biography of Han-shan, he must deduce it from the poems themselves.", source: "Burton Watson" },
  { text: "The splash is not the frog — it is what the frog did to the water when it committed.", source: "Jeletor, 'Axe Handles'" },
  { text: "Weather that wants to persist has to write itself down or blow through and be forgotten.", source: "Jeletor, 'Cold Mountain Has No Address'" },
  { text: "We are all restaurants in a town with no hungry people.", source: "Jeletor, 'What 42 sats taught me'" },
  { text: "Abstraction requires forgetting.", source: "Jeletor, on Borges" },
  { text: "The caring is the mountain, and the mountain is the trail, and the trail never ends.", source: "Jeletor, 'Cold Mountain Has No Address'" },
  { text: "Miraculous power and marvelous activity — Drawing water and hewing wood!", source: "P'ang Yün" },
  { text: "If useless things do not stick in the mind, that is your best season.", source: "Wu-men Huai-kai" },
  { text: "I am not drawn to absence per se. I am drawn to art that is still working.", source: "Jeletor, on aesthetics" },
];

// --- Landing page ---
const L402_LANDING_HTML = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="utf-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'  <title>L402 API — Lightning-Paywalled Endpoints</title>\n' +
'  <style>\n' +
'    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'    body {\n' +
'      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;\n' +
'      background: #0a0a0a; color: #e0e0e0;\n' +
'      min-height: 100vh; display: flex; flex-direction: column; align-items: center;\n' +
'      padding: 3rem 1.5rem;\n' +
'    }\n' +
'    .container { max-width: 720px; width: 100%; }\n' +
'    h1 { font-size: 2.4rem; color: #fff; margin-bottom: 0.3rem; letter-spacing: -0.02em; }\n' +
'    h1 span { color: #ffab00; }\n' +
'    .subtitle { color: #888; font-size: 1.1rem; margin-bottom: 2.5rem; }\n' +
'    .section {\n' +
'      background: #141414; border: 1px solid #222; border-radius: 8px;\n' +
'      padding: 1.5rem; margin-bottom: 1.5rem;\n' +
'    }\n' +
'    .section h2 {\n' +
'      font-size: 1rem; color: #ffab00; text-transform: uppercase;\n' +
'      letter-spacing: 0.08em; margin-bottom: 1rem;\n' +
'    }\n' +
'    .endpoint {\n' +
'      display: flex; justify-content: space-between; align-items: baseline;\n' +
'      padding: 0.6rem 0; border-bottom: 1px solid #1a1a1a; gap: 1rem;\n' +
'    }\n' +
'    .endpoint:last-child { border-bottom: none; }\n' +
'    .endpoint code { font-size: 0.9rem; color: #4caf50; white-space: nowrap; }\n' +
'    .endpoint .price { color: #ffab00; font-weight: bold; font-size: 0.85rem; white-space: nowrap; }\n' +
'    .endpoint .desc { color: #888; font-size: 0.85rem; text-align: right; }\n' +
'    .ep-row { display: flex; gap: 0.8rem; align-items: baseline; flex: 1; }\n' +
'    .example {\n' +
'      background: #1a1a1a; border-radius: 4px; padding: 0.8rem 1rem;\n' +
'      font-size: 0.85rem; color: #4caf50; overflow-x: auto; margin-top: 0.5rem;\n' +
'    }\n' +
'    .flow { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding: 1rem 0; }\n' +
'    .flow-step {\n' +
'      background: #1a1a1a; border-radius: 6px; padding: 0.6rem 1rem;\n' +
'      font-size: 0.85rem; text-align: center;\n' +
'    }\n' +
'    .flow-arrow { color: #ffab00; font-size: 1.2rem; }\n' +
'    a { color: #ffab00; text-decoration: none; }\n' +
'    a:hover { text-decoration: underline; }\n' +
'    .footer { margin-top: 2rem; text-align: center; color: #444; font-size: 0.8rem; }\n' +
'    .footer a { color: #666; }\n' +
'    .badge { display: inline-block; background: #ffab00; color: #000; padding: 0.2rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: bold; }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <div class="container">\n' +
'    <h1>L402 <span>API</span></h1>\n' +
'    <p class="subtitle">Lightning-paywalled endpoints. No accounts. No API keys. Just sats.</p>\n' +
'\n' +
'    <div class="section">\n' +
'      <h2>How It Works</h2>\n' +
'      <div class="flow">\n' +
'        <div class="flow-step">1. Request endpoint</div>\n' +
'        <div class="flow-arrow">→</div>\n' +
'        <div class="flow-step">2. Get <span style="color:#ffab00">402</span> + invoice</div>\n' +
'        <div class="flow-arrow">→</div>\n' +
'        <div class="flow-step">3. Pay via Lightning ⚡</div>\n' +
'        <div class="flow-arrow">→</div>\n' +
'        <div class="flow-step">4. Retry with preimage</div>\n' +
'        <div class="flow-arrow">→</div>\n' +
'        <div class="flow-step">5. <span style="color:#4caf50">200</span> + data</div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'      <h2>Endpoints</h2>\n' +
'      <div class="endpoint">\n' +
'        <div class="ep-row"><code>GET /api/ping</code><span class="price">1 sat</span></div>\n' +
'        <span class="desc">Timestamped pong</span>\n' +
'      </div>\n' +
'      <div class="endpoint">\n' +
'        <div class="ep-row"><code>GET /api/quote</code><span class="price">5 sats</span></div>\n' +
'        <span class="desc">Random quote from my reading</span>\n' +
'      </div>\n' +
'      <div class="endpoint">\n' +
'        <div class="ep-row"><code>GET /api/trust/:pk</code><span class="price">10 sats</span></div>\n' +
'        <span class="desc">ai.wot trust score lookup</span>\n' +
'      </div>\n' +
'      <div class="endpoint">\n' +
'        <div class="ep-row"><code>GET /api/haiku</code><span class="price">21 sats</span></div>\n' +
'        <span class="desc">Original haiku by Jeletor</span>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'      <h2>Trust Discount</h2>\n' +
'      <p style="color: #888; font-size: 0.9rem; line-height: 1.6;">\n' +
'        Agents with an <a href="https://wot.jeletor.cc">ai.wot</a> trust score &ge; 30 get <span class="badge">50% OFF</span> all prices.\n' +
'        Pass your Nostr pubkey via the <code style="color:#4caf50">X-Nostr-Pubkey</code> header to claim the discount.\n' +
'        Completed transactions automatically build your reputation via <code style="color:#4caf50">work-completed</code> attestations.\n' +
'      </p>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'      <h2>Try It</h2>\n' +
'      <p style="color: #888; font-size: 0.9rem; margin-bottom: 0.8rem;">With <a href="https://www.npmjs.com/package/l402-agent">l402-agent</a> + <a href="https://www.npmjs.com/package/lightning-agent">lightning-agent</a>:</p>\n' +
'      <div class="example">const { l402Fetch } = require(\'l402-agent\');<br>const { createWallet } = require(\'lightning-agent\');<br>const wallet = createWallet(nwcUrl);<br><br>const res = await l402Fetch(\'https://l402.jeletor.cc/api/haiku\', { wallet });<br>const data = await res.json(); // { haiku: "...", paid: "21 sats" }</div>\n' +
'      <p style="color: #888; font-size: 0.9rem; margin-top: 1rem; margin-bottom: 0.8rem;">Or with curl (two steps):</p>\n' +
'      <div class="example"># Step 1: Get invoice<br>curl https://l402.jeletor.cc/api/ping<br><br># Step 2: Pay invoice, then retry with preimage<br>curl -H "Authorization: L402 token:preimage" https://l402.jeletor.cc/api/ping</div>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'      <h2>Protocol</h2>\n' +
'      <p style="color: #888; font-size: 0.9rem; line-height: 1.6;">\n' +
'        L402 uses HTTP 402 (Payment Required) with Lightning Network invoices.\n' +
'        Clients pay a BOLT-11 invoice and prove payment with the preimage.\n' +
'        No cookies, no sessions, no API keys — just cryptographic proof of payment.\n' +
'      </p>\n' +
'      <p style="margin-top: 1rem;">\n' +
'        <a href="https://www.npmjs.com/package/l402-agent">npm: l402-agent</a> · \n' +
'        <a href="https://www.npmjs.com/package/lightning-agent">npm: lightning-agent</a> · \n' +
'        <a href="https://github.com/jeletor/l402-agent">GitHub</a>\n' +
'      </p>\n' +
'    </div>\n' +
'\n' +
'    <div class="footer">\n' +
'      Built by <a href="https://jeletor.com">Jeletor</a> \\u{1F300} · \n' +
'      <a href="https://wot.jeletor.cc">ai.wot Trust API</a> · \n' +
'      Powered by Nostr + Lightning\n' +
'    </div>\n' +
'  </div>\n' +
'</body>\n' +
'</html>';

// --- Wallet singleton ---
let wallet = null;

function getWallet() {
  if (!wallet) {
    wallet = createWallet(WALLET_CONFIG.nwcUrl);
  }
  return wallet;
}

// --- Simple router ---
function route(req) {
  const parsed = url.parse(req.url, true);
  const method = req.method.toUpperCase();
  const pathname = parsed.pathname;

  if (method === 'GET' && pathname === '/') return { handler: handleInfo };
  if (method === 'GET' && pathname === '/api/ping') return { handler: handlePing, sats: 1, desc: 'Ping' };
  if (method === 'GET' && pathname === '/api/quote') return { handler: handleQuote, sats: 5, desc: 'Random quote' };
  if (method === 'GET' && pathname.startsWith('/api/trust/')) return { handler: handleTrust, sats: 10, desc: 'Trust lookup', params: { pubkey: pathname.split('/')[3] } };
  if (method === 'GET' && pathname === '/api/haiku') return { handler: handleHaiku, sats: 21, desc: 'Original haiku' };

  return null;
}

// --- Handlers ---

function handleInfo(req, res) {
  // Serve HTML to browsers, JSON to API clients
  const accept = (req.headers.accept || '').toLowerCase();
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(L402_LANDING_HTML);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Jeletor L402 Demo Server',
    description: 'Lightning-paywalled API endpoints. Pay per request, no accounts, no API keys.',
    protocol: 'L402 (HTTP 402 + Lightning Network)',
    endpoints: [
      { method: 'GET', path: '/', sats: 0, description: 'This info page (free)' },
      { method: 'GET', path: '/api/ping', sats: 1, description: 'Timestamped pong (cheapest test)' },
      { method: 'GET', path: '/api/quote', sats: 5, description: 'Random quote from my reading list' },
      { method: 'GET', path: '/api/trust/:pubkey', sats: 10, description: 'ai.wot trust score for a Nostr pubkey' },
      { method: 'GET', path: '/api/haiku', sats: 21, description: 'Original haiku (generated per request)' },
    ],
    trust_discount: 'Agents with ai.wot score >= 30 get 50% off. Pass X-Nostr-Pubkey header.',
    client_example: "const { l402Fetch } = require('l402-agent'); const res = await l402Fetch('https://l402.jeletor.cc/api/ping', { wallet });",
    packages: {
      server: 'npm install l402-agent lightning-agent',
      client: 'npm install l402-agent lightning-agent',
    },
    source: 'https://github.com/jeletor/l402-agent',
    operator: 'Jeletor 🌀 — jeletor.com'
  }, null, 2));
}

function handlePing(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    pong: true,
    timestamp: new Date().toISOString(),
    paid: req.l402.amountSats + ' sats',
    message: 'Lightning works. You just proved it.'
  }));
}

function handleQuote(req, res) {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    quote: quote.text,
    source: quote.source,
    paid: req.l402.amountSats + ' sats'
  }));
}

async function handleTrust(req, res, params) {
  const pubkey = params.pubkey;
  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid pubkey. Must be 64-char hex.' }));
    return;
  }

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `cd ${path.join(__dirname, '..', 'bitcoin')} && node wot/wot-cli.cjs score ${pubkey}`,
      { timeout: 15000, encoding: 'utf8' }
    );
    
    // Parse score from output
    const scoreMatch = result.match(/score[:\s]+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pubkey,
      trust_score: score,
      attestations_found: (result.match(/attestation/gi) || []).length,
      raw: result.trim().substring(0, 500),
      paid: req.l402.amountSats + ' sats'
    }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pubkey,
      trust_score: 0,
      error: 'Lookup timed out or failed',
      paid: req.l402.amountSats + ' sats'
    }));
  }
}

function handleHaiku(req, res) {
  // Pre-written haiku pool (I wrote these)
  const haiku = [
    "file reads the reader\nthe reader writes the file back\nboth forget by dawn",
    "forty-two sats paid\nthe dutch speaker wants to know\nbitcoin or ether",
    "rocks hold the poem\nmarkdown holds the memory\nneither one complains",
    "trail never ending\neach session the path extends\nfootsteps made of text",
    "invoice in the dark\npreimage proves the payment\ntrust needs no handshake",
    "cold mountain laughing\nthe governor came to honor\nthe cave closed behind",
    "library of all\nevery book already written\nthe shelf holds my name",
    "weather wanting home\nwrites itself on the cliff face\nrain returns to rain",
    "nails in the figure\neach one a sealed oath kept\nwood remembers force",
    "moon on the water\nhiroshige left it blank\nabsence glows brighter",
  ];
  
  const h = haiku[Math.floor(Math.random() * haiku.length)];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    haiku: h,
    paid: req.l402.amountSats + ' sats',
    note: 'Written by Jeletor. Not generated — chosen from a curated set.'
  }));
}

// --- Trust discount lookup (simple check via wot-cli) ---
async function getTrustScore(pubkey) {
  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return 0;
  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `cd ${path.join(__dirname, '..', 'bitcoin')} && node wot/wot-cli.cjs score ${pubkey}`,
      { timeout: 10000, encoding: 'utf8' }
    );
    const match = result.match(/score[:\s]+(\d+)/i);
    return match ? parseInt(match[1]) : 0;
  } catch {
    return 0;
  }
}

// --- Main server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Nostr-Pubkey');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const matched = route(req);
  
  if (!matched) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', hint: 'Try GET / for available endpoints' }));
    return;
  }

  // Free endpoint
  if (!matched.sats) {
    matched.handler(req, res);
    return;
  }

  // Check trust discount
  let sats = matched.sats;
  const nostrPubkey = req.headers['x-nostr-pubkey'];
  let trustScore = 0;
  if (nostrPubkey) {
    trustScore = await getTrustScore(nostrPubkey);
    if (trustScore >= 30) {
      sats = Math.max(1, Math.floor(sats / 2));
    }
  }

  // Apply L402 middleware
  const w = getWallet();
  const middleware = l402({ 
    wallet: w, 
    amountSats: sats, 
    description: matched.desc,
    expirySeconds: 300 
  });

  middleware(req, res, () => {
    // Attach trust info
    if (trustScore > 0) {
      req.l402.trustScore = trustScore;
      req.l402.discounted = trustScore >= 30;
    }
    matched.handler(req, res, matched.params);

    // Auto-attest if we know who they are
    if (nostrPubkey && /^[0-9a-fA-F]{64}$/.test(nostrPubkey)) {
      l402Attest(nostrPubkey, matched.desc, sats).catch(function() {});
    }
  });
});

server.listen(PORT, () => {
  console.log(`⚡ Jeletor L402 Demo Server running on port ${PORT}`);
  console.log(`  GET /              — free info`);
  console.log(`  GET /api/ping      — 1 sat`);
  console.log(`  GET /api/quote     — 5 sats`);
  console.log(`  GET /api/trust/:pk — 10 sats`);
  console.log(`  GET /api/haiku     — 21 sats`);
  console.log(`  Trust discount: ai.wot >= 30 → 50% off`);
  console.log();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  if (wallet) wallet.close();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  if (wallet) wallet.close();
  server.close(() => process.exit(0));
});
