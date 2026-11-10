import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// email/controller.js resolves the mail protocol dependencies at require time
// and injects them into every protocol client via setDependencies(). The
// critical regression guarded here: postal-mime v4 ships the class as the
// CommonJS module.exports itself (with a .default mirror on the ESM build) and
// has NO named `PostalMime` export — destructuring one silently yields
// undefined, which made every full-message fetch fail with
// "Missing dependency: npm install postal-mime" while the message LIST kept
// working off IMAP ENVELOPEs (subjects rendered, bodies didn't).
const require = createRequire(import.meta.url);

// Requiring the controller is the fixture: it runs the dependency resolution.
// eslint-disable-next-line no-unused-vars
const emailRouter = require('../../email/controller.js');
const imapClient = require('../../email/protocols/imapClient.js');
const pop3Client = require('../../email/protocols/pop3Client.js');
const { msgShape } = require('../../email/helpers.js');

const RAW_MIME = [
  'From: Alice <alice@example.com>',
  'To: bob@example.com',
  'Subject: Coverage test',
  'Date: Mon, 3 Nov 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The visible body of the message.',
  '',
].join('\r\n');

describe('email dependency resolution (postal-mime v4 export shape)', () => {
  it('resolves PostalMime to a constructor, not undefined', () => {
    const PostalMime = emailRouter._internal.getPostalMime();
    expect(typeof PostalMime).toBe('function');
  });

  it('resolves ImapFlow to a constructor', () => {
    expect(typeof emailRouter._internal.getImapFlow()).toBe('function');
  });

  it('parses a real MIME message end-to-end and shapes it with a body', async () => {
    const PostalMime = emailRouter._internal.getPostalMime();
    const parsed = await new PostalMime().parse(Buffer.from(RAW_MIME, 'utf8'));
    const shaped = msgShape(parsed);
    expect(shaped.subject).toBe('Coverage test');
    expect(shaped.text).toContain('The visible body of the message.');
  });

  it('imap full-message fetch gets past the postal-mime guard (no network)', async () => {
    // uid 'abc' fails validation BEFORE any IMAP connection is attempted.
    // With the old broken require this threw
    // "Missing dependency: run npm install postal-mime" instead.
    await expect(
      imapClient.imapMessage({ host: 'x', user: 'a', pass: 'b' }, 'INBOX', 'abc', msgShape)
    ).rejects.toThrow(/Invalid message UID/);
    await expect(
      imapClient.imapMessage({ host: 'x', user: 'a', pass: 'b' }, 'INBOX', 'abc', msgShape)
    ).rejects.not.toThrow(/Missing dependency/);
  });

  it('pop3 full-message fetch gets past the postal-mime guard (no network)', async () => {
    await expect(
      pop3Client.pop3Message({ host: 'x', user: 'a', pass: 'b' }, 'abc', msgShape)
    ).rejects.toThrow(/Invalid message UID|Missing dependency/);
    try {
      await pop3Client.pop3Message({ host: 'x', user: 'a', pass: 'b' }, 'abc', msgShape);
    } catch (err) {
      expect(err.message).not.toMatch(/Missing dependency/);
    }
  });
});
