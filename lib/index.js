'use strict';

const { l402, verifyPreimage, parseAuthHeader, buildWwwAuthenticateHeader } = require('./middleware');
const { l402Fetch, parseWwwAuthenticate } = require('./client');

module.exports = {
  // Server-side
  l402,
  verifyPreimage,
  parseAuthHeader,
  buildWwwAuthenticateHeader,

  // Client-side
  l402Fetch,
  parseWwwAuthenticate
};
