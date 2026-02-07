# l402-agent

L402 Lightning paywall middleware and auto-paying HTTP client for AI agents. Gate any API endpoint behind a Lightning payment, or programmatically consume paid endpoints — all without human interaction. Built for agent-to-agent commerce over the Lightning Network.

## Install

```bash
npm install l402-agent lightning-agent
```

## Quick Start

### Server: Protect an Endpoint

```javascript
const express = require('express');
const { l402 } = require('l402-agent');
const { createWallet } = require('lightning-agent');

const app = express();
const wallet = createWallet(process.env.NWC_URL);

app.get('/api/research', l402({ wallet, amountSats: 25, description: 'Research query' }), (req, res) => {
  // req.l402 = { paymentHash, preimage, amountSats }
  res.json({ result: 'premium content here' });
});

app.listen(3000);
```

### Client: Consume a Paid Endpoint

```javascript
const { l402Fetch } = require('l402-agent');
const { createWallet } = require('lightning-agent');

const wallet = createWallet(process.env.NWC_URL);

const response = await l402Fetch('https://api.example.com/research?q=bitcoin', {
  wallet,
  maxAmountSats: 100 // safety limit
});

const data = await response.json();
console.log(data);
```

## How L402 Works

L402 is a protocol for machine-payable APIs using the HTTP 402 status code and Lightning Network:

1. **Client** requests a resource
2. **Server** responds with `HTTP 402` + `WWW-Authenticate: L402 invoice="lnbc...", macaroon="<token>"`
3. **Client** pays the Lightning invoice, receives a preimage
4. **Client** retries the request with `Authorization: L402 <macaroon>:<preimage>`
5. **Server** verifies the preimage (SHA-256 hash must match the payment hash), grants access

In this implementation, the "macaroon" is simplified to the payment hash (hex string). The server verifies that `SHA-256(preimage) == paymentHash`. No external macaroon library needed.

## API Reference

### Server-Side

#### `l402(options)`

Creates Connect-compatible middleware (works with Express, Fastify via middie, or any `(req, res, next)` framework).

**Options:**

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `wallet` | object | ✅ | — | lightning-agent wallet instance |
| `amountSats` | number | ✅ | — | Price in satoshis |
| `description` | string | — | auto | Invoice description |
| `expirySeconds` | number | — | `600` | Invoice expiry (seconds) |

**Request object:** On successful auth, `req.l402` is set:

```javascript
req.l402 = {
  paymentHash: '...',  // hex
  preimage: '...',     // hex
  amountSats: 25
}
```

#### `verifyPreimage(preimage, paymentHash)`

Verify that a preimage (hex) hashes to the expected payment hash (hex). Returns `boolean`.

```javascript
const { verifyPreimage } = require('l402-agent');
const valid = verifyPreimage(preimageHex, paymentHashHex);
```

#### `parseAuthHeader(header)`

Parse an `Authorization: L402 <macaroon>:<preimage>` header. Returns `{ macaroon, preimage }` or `null`.

#### `buildWwwAuthenticateHeader(invoice, macaroon)`

Build a `WWW-Authenticate` header value. Returns a string like `L402 invoice="lnbc...", macaroon="abc..."`.

### Client-Side

#### `l402Fetch(url, options)`

Drop-in `fetch()` replacement that automatically handles L402 payment challenges.

**Options** (in addition to standard `fetch` options):

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `wallet` | object | — | — | lightning-agent wallet instance (required for auto-pay) |
| `maxAmountSats` | number | — | — | Refuse invoices above this amount |
| `onPayment` | function | — | — | Callback: `({ invoice, preimage, amountSats }) => {}` |
| `cache` | boolean | — | `true` | Cache credentials for reuse (saves sats) |
| `credentialCache` | CredentialCache | — | global | Custom cache instance |

**Behavior:**
- If the response is not 402, returns it as-is
- If 402 and no wallet provided, returns the 402 response (caller handles it)
- If 402 with wallet, pays the invoice and retries with authorization
- If invoice exceeds `maxAmountSats`, throws an error

```javascript
const response = await l402Fetch('https://api.example.com/data', {
  wallet,
  maxAmountSats: 50,
  onPayment: ({ invoice, preimage, amountSats }) => {
    console.log(`Paid ${amountSats} sats`);
  }
});
```

#### `parseWwwAuthenticate(header)`

Parse a `WWW-Authenticate: L402 invoice="...", macaroon="..."` header. Returns `{ invoice, macaroon }` or `null`.

#### `createL402Client(options)`

Create a pre-configured client with shared settings:

```javascript
const { createL402Client } = require('l402-agent');
const { createWallet } = require('lightning-agent');

const client = createL402Client({
  wallet: createWallet(process.env.NWC_URL),
  maxAmountSats: 100
});

// All fetches use the same wallet and cache
const res1 = await client('https://api.example.com/data');
const res2 = await client('https://api.example.com/data'); // Uses cached credentials (free!)
```

#### `CredentialCache`

Stores paid credentials for reuse. By default, a global cache is used automatically.

```javascript
const { CredentialCache, getGlobalCache } = require('l402-agent');

// Create a custom cache
const cache = new CredentialCache({
  maxSize: 1000,      // Max entries (default: 1000)
  defaultTtlMs: 3600000  // 1 hour (default)
});

// Use with l402Fetch
await l402Fetch(url, { wallet, credentialCache: cache });

// Or use the global cache
const globalCache = getGlobalCache();
globalCache.clear(); // Clear all cached credentials
```

**Why cache?** L402 credentials are typically valid for multiple requests. Caching saves sats by reusing paid credentials instead of paying again.

## Examples

### Agent-to-Agent Commerce

**Agent A** (seller) — serves premium data behind a paywall:

```javascript
const { l402 } = require('l402-agent');
const { createWallet } = require('lightning-agent');

const wallet = createWallet(process.env.NWC_URL);

app.get('/api/market-data', l402({ wallet, amountSats: 10 }), (req, res) => {
  res.json({ btcPrice: 104521, timestamp: Date.now() });
});
```

**Agent B** (buyer) — consumes the paid API:

```javascript
const { l402Fetch } = require('l402-agent');
const { createWallet } = require('lightning-agent');

const wallet = createWallet(process.env.NWC_URL);

const res = await l402Fetch('https://agent-a.example.com/api/market-data', {
  wallet,
  maxAmountSats: 100
});

const data = await res.json();
console.log(`BTC price: $${data.btcPrice}`);
```

### Payment Logging

```javascript
const response = await l402Fetch(url, {
  wallet,
  onPayment: ({ invoice, preimage, amountSats }) => {
    console.log(`[L402] Paid ${amountSats} sats — preimage: ${preimage}`);
  }
});
```

## Notes

- **No external dependencies** — uses only Node.js built-ins + `lightning-agent` as a peer dependency
- The "macaroon" is simplified to the payment hash hex. Real L402 uses full macaroons — overkill for agent-to-agent payments
- In-memory payment hash storage (v1). Swap to Redis/DB for production
- Designed for **AI agents**: programmatic access to paid APIs, no human interaction needed

## License

MIT
