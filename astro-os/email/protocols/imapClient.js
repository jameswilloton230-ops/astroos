'use strict';

let ImapFlow, PostalMime;

function missingDep(name) {
  return new Error(`Missing dependency: run "npm install ${name}"`);
}

function setDependencies(deps) {
  ImapFlow = deps.ImapFlow;
  PostalMime = deps.PostalMime;
}

// Memoized HTML entity decoder for folder paths, subject lines, and headers
const decodedPathCache = new Map();
const MAX_ENTITY_CACHE_SIZE = 500;

function decodeEntities(str) {
  if (!str || typeof str !== 'string' || !str.includes('&')) return str;
  if (decodedPathCache.has(str)) return decodedPathCache.get(str);

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

  if (decodedPathCache.size > MAX_ENTITY_CACHE_SIZE) {
    const firstKey = decodedPathCache.keys().next().value;
    decodedPathCache.delete(firstKey);
  }
  decodedPathCache.set(str, decoded);
  return decoded;
}

// Common folder name aliases across email providers
const FOLDER_ALIASES = {
  inbox: ['inbox'],
  sent: ['sent', 'sent mail', 'sent messages', 'sent items', '[gmail]/sent mail'],
  drafts: ['drafts', 'draft', '[gmail]/drafts'],
  trash: ['trash', 'deleted', 'deleted items', 'bin', '[gmail]/trash'],
  spam: ['spam', 'junk', 'junk e-mail', 'junk mail', 'bulk mail', '[gmail]/spam'],
  archive: ['archive', 'all mail', '[gmail]/all mail'],
};

async function imapConnect(creds) {
  if (!ImapFlow) throw missingDep('imapflow');
  if (!creds || !creds.host || !creds.user || !creds.pass) {
    throw new Error('IMAP connection requires host, user, and pass');
  }
  // TLS is mandatory. creds.ssl used to gate this (secure: Boolean(creds.ssl)),
  // which let a request that simply omitted or set ssl:false connect over
  // plaintext IMAP on port 143 with credentials and mail sent in the clear.
  // There's no legitimate reason to support that path, so refuse it outright
  // rather than trusting the caller to opt in.
  if (!creds.ssl) {
    throw new Error('Plaintext IMAP is not supported — TLS (implicit SSL) is required');
  }

  const client = new ImapFlow({
    host: creds.host,
    port: parseInt(creds.port, 10) || 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    tls: { rejectUnauthorized: true },
    timeout: 10000,
    commandTimeout: 30000,
    idleTimeout: 30 * 60 * 1000
  });

  await client.connect();
  return client;
}

async function imapFolders(creds) {
  const client = await imapConnect(creds);
  try {
    const list = await client.list();
    return list.map(m => ({
      path: decodeEntities(m.path),
      name: decodeEntities(m.name || m.path.split(m.delimiter || '/').pop()),
      delimiter: m.delimiter,
      flags: [...(m.flags || [])]
    }));
  } finally {
    await client.logout().catch(() => {});
  }
}

async function resolveFolder(client, folder) {
  const decodedFolder = decodeEntities(folder);
  try {
    return await client.mailboxOpen(decodedFolder);
  } catch {
    const needle = decodedFolder.toLowerCase().replace(/^.*\//, '');
    const aliases = FOLDER_ALIASES[needle] || [needle];
    const list = await client.list();
    const match = list.find(f =>
      aliases.some(a => f.path.toLowerCase() === a || (f.name || '').toLowerCase() === a)
    );
    if (!match) throw new Error(`Folder not found: ${folder}`);
    return client.mailboxOpen(match.path);
  }
}

async function imapMessages(creds, folder, page, limit, msgShape) {
  const client = await imapConnect(creds);
  try {
    const box = await resolveFolder(client, folder);
    const total = box.exists || 0;
    const totalPages = Math.ceil(total / limit) || 0;

    if (total === 0 || (page - 1) * limit >= total) {
      return { messages: [], total, page, pages: totalPages };
    }

    const end = Math.max(1, total - (page - 1) * limit);
    const start = Math.max(1, end - limit + 1);

    const messages = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      uid: true, flags: true, envelope: true
    })) {
      const env = msg.envelope || {};
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        seen: msg.flags?.has('\\Seen') || false,
        subject: decodeEntities(env.subject || '(no subject)'),
        from: env.from?.[0]
          ? [env.from[0].name, `<${env.from[0].address}>`].filter(Boolean).join(' ').trim()
          : '',
        to: (env.to || []).map(a => a.address).filter(Boolean).join(', '),
        date: env.date ? new Date(env.date).toISOString() : null
      });
    }
    return { messages: messages.reverse(), total, page, pages: totalPages };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function imapMessage(creds, folder, uid, msgShape) {
  if (!PostalMime) throw missingDep('postal-mime');
  const numericUid = parseInt(uid, 10);
  if (!numericUid || isNaN(numericUid)) {
    throw new Error('Invalid message UID');
  }

  const client = await imapConnect(creds);
  try {
    await resolveFolder(client, folder);
    let raw = null;
    for await (const msg of client.fetch(String(numericUid), { source: true }, { uid: true })) {
      raw = msg.source;
    }
    if (!raw) throw new Error('Message not found');

    const parser = new PostalMime();
    const parsed = await parser.parse(raw);
    return typeof msgShape === 'function' ? msgShape(parsed) : parsed;
  } finally {
    await client.logout().catch(() => {});
  }
}

async function imapBatch(creds, op, uids, folder, dest) {
  if (!ImapFlow) throw missingDep('imapflow');
  if (!Array.isArray(uids) || uids.length === 0) return;

  const client = await imapConnect(creds);
  try {
    await resolveFolder(client, folder);
    if (op === 'delete') {
      await client.messageDelete(uids, { uid: true });
    } else if (op === 'read') {
      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    } else if (op === 'move' && dest) {
      await client.messageMove(uids, decodeEntities(dest), { uid: true });
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function imapSearch(creds, query, folder) {
  if (!ImapFlow) throw missingDep('imapflow');
  const client = await imapConnect(creds);
  try {
    await resolveFolder(client, folder);
    const uids = await client.search(
      { or: [{ subject: query }, { from: query }, { body: query }] },
      { uid: true }
    );
    const messages = [];
    if (Array.isArray(uids) && uids.length > 0) {
      const recentUids = uids.slice(-40).reverse();
      for await (const msg of client.fetch(recentUids, { envelope: true, flags: true }, { uid: true })) {
        const env = msg.envelope || {};
        messages.push({
          uid: msg.uid,
          subject: decodeEntities(env.subject || '(no subject)'),
          from: env.from?.[0]?.address || '',
          date: env.date ? new Date(env.date).toISOString() : null,
          seen: msg.flags?.has('\\Seen') || false
        });
      }
    }
    return messages;
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = {
  setDependencies,
  imapConnect,
  imapFolders,
  imapMessages,
  imapMessage,
  imapBatch,
  imapSearch,
  resolveFolder,
  decodeEntities
};