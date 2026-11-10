// Minimal Deno shim so Edge Function modules that touch `Deno.env` at import
// time can be loaded by the Node test runner. Import (or --import) this file
// BEFORE importing any function module.
const envStore = new Map();

globalThis.Deno ??= {
  env: {
    get(name) {
      return envStore.get(name);
    },
    set(name, value) {
      envStore.set(name, String(value));
    },
    has(name) {
      return envStore.has(name);
    },
    toObject() {
      return Object.fromEntries(envStore);
    },
  },
};

export function setEnv(name, value) {
  if (value === undefined) envStore.delete(name);
  else envStore.set(name, value);
}

export const env = envStore;
