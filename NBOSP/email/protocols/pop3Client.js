'use strict';

let POP3Client, PostalMime;
let POP3ClientPromise;

function missingDep(name) {
  return new Error(`Missing dependency: run "npm install ${name}"`);
}

const decodedEntityCache = new Map();
const MAX_CACHE_SIZE = 500;

function decodeEntities(str) {
  if (!str || typeof str !== 'string' || !str.includes('&')) return str;
  if (decodedEntityCache.has(str)) return decodedEntityCache.get(str);

  const decoded = str
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x22;/gi, '"');

  if (decodedEntityCache.size > MAX_CACHE_SIZE) {
    const firstKey = decodedEntityCache.keys().next().value;
    decodedEntityCache.delete(firstKey);
  }
  decodedEntityCache.set(str, decoded);
  return decoded;
}

function setDependencies(deps) {
  POP3Client = deps.POP3Client;
  POP3ClientPromise = POP3Client ? Promise.resolve(POP3Client) : null;
  PostalMime = deps.PostalMime;
}

async function getPOP3Client() {
  if (POP3Client) return POP3Client;
  if (!POP3ClientPromise) {
    POP3ClientPromise = import('node-pop3').then(module => {
      if (typeof module.default !== 'function') {
        throw new TypeError('node-pop3 did not export a POP3 client constructor');
      }
      POP3Client = module.default;
      return POP3Client;
    }).catch(error => {
      POP3ClientPromise = null;
      throw new Error(`Could not load node-pop3: ${error.message}`, { cause: error });
    });
  }
  return POP3ClientPromise;
}

async function pop3Messages(creds, limit, msgShape) {
  const Client = await getPOP3Client();
  if (!PostalMime) throw missingDep('postal-mime');
  if (!creds || !creds.host || !creds.user || !creds.pass) {
    throw new Error('POP3 connection requires host, user, and pass');
  }
  // TLS is mandatory — see imapClient.js for why creds.ssl can no longer
  // gate whether encryption happens at all.
  if (!creds.ssl) {
    throw new Error('Plaintext POP3 is not supported — TLS (implicit SSL) is required');
  }

  const port = parseInt(creds.port, 10) || 995;
  const client = new Client({
    host: creds.host,
    port,
    tls: true,
    user: creds.user,
    password: creds.pass
  });

  try {
    const [countStr] = await client.STAT();
    const total = parseInt(countStr, 10) || 0;
    const messages = [];

    if (total === 0) {
      return { messages: [], total: 0, page: 1, pages: 1 };
    }

    const fetchLimit = Math.min(total, Math.max(1, parseInt(limit, 10) || 20));
    const parser = new PostalMime();

    for (let i = total; i > total - fetchLimit; i--) {
      try {
        const raw = await client.RETR(i);
        const parsed = await parser.parse(raw);
        messages.push({
          uid: i,
          seq: i,
          seen: false,
          subject: decodeEntities(parsed.subject || '(no subject)'),
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          date: parsed.date instanceof Date ? parsed.date.toISOString() : null
        });
      } catch {
        // Skip malformed individual messages
      }
    }

    return { messages, total, page: 1, pages: 1 };
  } finally {
    await client.QUIT().catch(() => {});
  }
}

async function pop3Message(creds, uid, msgShape) {
  const Client = await getPOP3Client();
  if (!PostalMime) throw missingDep('postal-mime');

  const numericUid = parseInt(uid, 10);
  if (!numericUid || isNaN(numericUid)) {
    throw new Error('Invalid message UID');
  }

  const port = parseInt(creds.port, 10) || (creds.ssl ? 995 : 110);
  const client = new Client({
    host: creds.host,
    port,
    tls: Boolean(creds.ssl),
    user: creds.user,
    password: creds.pass
  });

  try {
    const raw = await client.RETR(numericUid);
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);
    return typeof msgShape === 'function' ? msgShape(parsed) : parsed;
  } finally {
    await client.QUIT().catch(() => {});
  }
}

module.exports = {
  setDependencies,
  pop3Messages,
  pop3Message
};