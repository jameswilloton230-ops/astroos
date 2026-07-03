/**
 * NovaByte - Safe Storage Wrapper
 * ────────────────────────────────────────────────────────────
 * Provides safe access to localStorage with fallback to in-memory
 * storage for sandboxed contexts where localStorage may be restricted.
 *
 * @module js/safe-storage
 */

const SafeStorage = (() => {
  let memoryStorage = new Map();
  let isLocalStorageAvailable = false;

  // Test if localStorage is available
  function testLocalStorage() {
    try {
      if (typeof localStorage === 'undefined') {
        return false;
      }
      const testKey = '__novabyte_storage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      // SecurityError, QuotaExceededError, or other errors mean localStorage is unavailable
      return false;
    }
  }

  isLocalStorageAvailable = testLocalStorage();

  return {
    /**
     * Get a value from storage
     * @param {string} key - Storage key
     * @param {*} defaultValue - Default value if key not found
     * @returns {*} Stored value or default
     */
    getItem(key, defaultValue = null) {
      if (isLocalStorageAvailable) {
        try {
          const value = localStorage.getItem(key);
          return value !== null ? value : defaultValue;
        } catch (error) {
          console.warn(`[SafeStorage] localStorage.getItem failed for key "${key}":`, error.message);
          return memoryStorage.get(key) ?? defaultValue;
        }
      }
      return memoryStorage.get(key) ?? defaultValue;
    },

    /**
     * Set a value in storage
     * @param {string} key - Storage key
     * @param {string} value - Value to store
     * @returns {boolean} Success status
     */
    setItem(key, value) {
      if (isLocalStorageAvailable) {
        try {
          localStorage.setItem(key, value);
          memoryStorage.set(key, value);
          return true;
        } catch (error) {
          console.warn(`[SafeStorage] localStorage.setItem failed for key "${key}":`, error.message);
          memoryStorage.set(key, value);
          return false;
        }
      }
      memoryStorage.set(key, value);
      return true;
    },

    /**
     * Remove a value from storage
     * @param {string} key - Storage key
     * @returns {boolean} Success status
     */
    removeItem(key) {
      if (isLocalStorageAvailable) {
        try {
          localStorage.removeItem(key);
          memoryStorage.delete(key);
          return true;
        } catch (error) {
          console.warn(`[SafeStorage] localStorage.removeItem failed for key "${key}":`, error.message);
          memoryStorage.delete(key);
          return false;
        }
      }
      memoryStorage.delete(key);
      return true;
    },

    /**
     * Clear all storage
     * @returns {boolean} Success status
     */
    clear() {
      if (isLocalStorageAvailable) {
        try {
          localStorage.clear();
          memoryStorage.clear();
          return true;
        } catch (error) {
          console.warn('[SafeStorage] localStorage.clear failed:', error.message);
          memoryStorage.clear();
          return false;
        }
      }
      memoryStorage.clear();
      return true;
    },

    /**
     * Get the number of items in storage
     * @returns {number} Item count
     */
    length() {
      return isLocalStorageAvailable 
        ? localStorage.length 
        : memoryStorage.size;
    },

    /**
     * Check if localStorage is available
     * @returns {boolean}
     */
    isAvailable() {
      return isLocalStorageAvailable;
    },

    /**
     * Get storage mode (for debugging)
     * @returns {string} "localStorage" or "memory"
     */
    getMode() {
      return isLocalStorageAvailable ? 'localStorage' : 'memory';
    }
  };
})();

// Make it globally available
if (typeof window !== 'undefined') {
  window.SafeStorage = SafeStorage;
}
