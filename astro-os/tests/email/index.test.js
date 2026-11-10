import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// email/index.js is a pure re-export shim for the controller router.
const indexRouter = require('../../email/index.js');
const controllerRouter = require('../../email/controller.js');

function routePaths(router) {
  const paths = new Set();
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) paths.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
  }
  return paths;
}

describe('email/index.js — route surface', () => {
  it('re-exports the controller router instance', () => {
    expect(indexRouter).toBe(controllerRouter);
    expect(typeof indexRouter).toBe('function');
  });

  it('exposes every documented endpoint from the module header', () => {
    const paths = routePaths(indexRouter);
    for (const expected of [
      'GET /csrf-token',
      'POST /connect',
      'GET /folders',
      'GET /messages',
      'GET /message',
      'POST /disconnect',
      'GET /restore',
      'GET /startup',
      'POST /batch',
      'POST /send',
      'GET /search',
      'POST /preview',
      'GET /preview/:token',
    ]) {
      expect(paths, `missing route ${expected}`).toContain(expected);
    }
  });

  it('guards the account-scoped routes with requireCreds', () => {
    for (const layer of indexRouter.stack) {
      if (!layer.route) continue;
      const guarded = layer.route.stack.some((l) => (l.handle && l.handle.name === 'requireCreds'));
      const path = layer.route.path;
      if (['/folders', '/messages', '/message', '/batch', '/send', '/search', '/preview'].includes(path)) {
        expect(guarded, `${path} should be behind requireCreds`).toBe(true);
      }
      if (['/csrf-token', '/connect', '/disconnect', '/restore', '/startup', '/preview/:token'].includes(path)) {
        expect(guarded, `${path} should be reachable pre-connect`).toBe(false);
      }
    }
  });
});
