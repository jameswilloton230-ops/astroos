'use strict';

const { randomUUID } = require('crypto');

const MAX_ENTRIES = 500;
const entries     = [];
const subscribers = new Set();

/**
 * Record a server-side event.
 *
 * @param {object} opts
 * @returns {object}
 */
function log(opts = {}) {
  const entry = {
    id:        randomUUID(),
    timestamp: Date.now(),
    app:       opts.app      || 'server',
    severity:  opts.severity || 'info',
    message:   opts.message  || '',
    data:      opts.data     || null,
  };

  entries.push(entry);

  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch (_) {
      // Isolate subscriber errors
    }
  }

  return entry;
}

function getAll() {
  return entries.slice();
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function clear() {
  entries.length = 0;
}

module.exports = {
  log,
  getAll,
  subscribe,
  clear,
};