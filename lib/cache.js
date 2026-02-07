'use strict';

/**
 * L402 Credential Cache
 * 
 * Stores paid L402 credentials (macaroon + preimage) for reuse.
 * Credentials are cached by URL and expire when the macaroon expires.
 */

class CredentialCache {
  constructor(opts = {}) {
    this.cache = new Map();
    this.maxSize = opts.maxSize || 1000;
    this.defaultTtlMs = opts.defaultTtlMs || 3600000; // 1 hour default
    
    // Cleanup expired entries periodically
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }
  
  /**
   * Generate a cache key from URL and optional scope.
   * @param {string} url - The request URL
   * @param {string} [method] - HTTP method (for method-specific caching)
   * @returns {string}
   */
  key(url, method) {
    // Normalize URL: remove query string for caching (credentials usually work across queries)
    const parsed = new URL(url);
    const normalized = `${parsed.origin}${parsed.pathname}`;
    return method ? `${method}:${normalized}` : normalized;
  }
  
  /**
   * Store a credential.
   * @param {string} url - The URL this credential is valid for
   * @param {object} credential
   * @param {string} credential.macaroon - The macaroon token
   * @param {string} credential.preimage - The payment preimage
   * @param {number} [credential.expiresAt] - Expiry timestamp (ms)
   * @param {string} [method] - HTTP method scope
   */
  set(url, credential, method) {
    const k = this.key(url, method);
    
    // Enforce max size (LRU eviction)
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    
    this.cache.set(k, {
      macaroon: credential.macaroon,
      preimage: credential.preimage,
      expiresAt: credential.expiresAt || Date.now() + this.defaultTtlMs,
      storedAt: Date.now()
    });
  }
  
  /**
   * Get a valid credential for a URL.
   * @param {string} url - The URL to get credentials for
   * @param {string} [method] - HTTP method scope
   * @returns {{ macaroon: string, preimage: string } | null}
   */
  get(url, method) {
    const k = this.key(url, method);
    const entry = this.cache.get(k);
    
    if (!entry) return null;
    
    // Check expiry
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return null;
    }
    
    return {
      macaroon: entry.macaroon,
      preimage: entry.preimage
    };
  }
  
  /**
   * Check if we have valid credentials for a URL.
   * @param {string} url
   * @param {string} [method]
   * @returns {boolean}
   */
  has(url, method) {
    return this.get(url, method) !== null;
  }
  
  /**
   * Invalidate credentials for a URL (e.g., on 401 after using cached creds).
   * @param {string} url
   * @param {string} [method]
   */
  invalidate(url, method) {
    const k = this.key(url, method);
    this.cache.delete(k);
  }
  
  /**
   * Clear all cached credentials.
   */
  clear() {
    this.cache.clear();
  }
  
  /**
   * Remove expired entries.
   */
  cleanup() {
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(k);
      }
    }
  }
  
  /**
   * Get cache statistics.
   * @returns {{ size: number, hits: number, misses: number }}
   */
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
  
  /**
   * Close the cache and stop cleanup interval.
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Global shared cache instance.
 */
let globalCache = null;

function getGlobalCache() {
  if (!globalCache) {
    globalCache = new CredentialCache();
  }
  return globalCache;
}

module.exports = {
  CredentialCache,
  getGlobalCache
};
