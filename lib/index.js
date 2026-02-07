'use strict';

const { l402, verifyPreimage, parseAuthHeader, buildWwwAuthenticateHeader } = require('./middleware');
const { l402Fetch, createL402Client, parseWwwAuthenticate, CredentialCache, getGlobalCache } = require('./client');

module.exports = {
  // Server-side
  l402,
  verifyPreimage,
  parseAuthHeader,
  buildWwwAuthenticateHeader,

  // Client-side
  l402Fetch,
  createL402Client,
  parseWwwAuthenticate,
  
  // Caching
  CredentialCache,
  getGlobalCache
};
