import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pop3Client = require('../../email/protocols/pop3Client.js');

describe('POP3 client dependency loading', () => {
  it('loads node-pop3 through its ESM export', async () => {
    pop3Client.setDependencies({ PostalMime: class PostalMime {} });

    try {
      await expect(pop3Client.pop3Messages({}, 20, () => {}))
        .rejects.toThrow('POP3 connection requires host, user, and pass');
    } finally {
      pop3Client.setDependencies({});
    }
  });
});
