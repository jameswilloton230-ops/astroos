'use strict';

window.NetworkLog = window.NetworkLog || {
  entries: [],
  MAX_ENTRIES: 500,
  _renderFn: null,

  push(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > this.MAX_ENTRIES) this.entries.length = this.MAX_ENTRIES;
    this._renderFn?.();
  },

  getAll() {
    return this.entries;
  },

  clear() {
    this.entries.length = 0;
    this._renderFn?.();
  },
};
