'use strict';

const https = require('https');

let PostalMime;

function setDependencies(deps) {
  PostalMime = deps.PostalMime;
}

function decodeEntities(str) {
  if (!str || typeof str !== 'string' || !str.includes('&')) return str;
  return str
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
}

function escapeXmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xval(xml, tag) {
  if (!xml || !tag) return '';
  const match = xml.match(new RegExp(`<(?:[a-z]:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-z]:)?${tag}>`, 'i'));
  return match ? decodeEntities(match[1].trim()) : '';
}

function ewsReq(creds, soapBody) {
  return new Promise((resolve, reject) => {
    if (!creds || !creds.host || !creds.user || !creds.pass) {
      return reject(new Error('Missing EWS credentials'));
    }

    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>${soapBody}</soap:Body>
</soap:Envelope>`;

    const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
    // Force https regardless of what scheme the user's host string carries.
    // This request sends Basic Auth (base64, not encryption) in a header —
    // over plain http that's a cleartext password on the wire on every
    // single call. Previously an "http://..." host string, or a bare
    // host that happened to route to a plaintext listener, was honored
    // as-is via `u.protocol === 'https:' ? https : http`.
    let urlStr = creds.host.replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
    if (!urlStr.endsWith('/EWS/Exchange.asmx')) urlStr += '/EWS/Exchange.asmx';

    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid EWS host URL: ${creds.host}`));
    }
    if (u.protocol !== 'https:') {
      return reject(new Error('Plaintext EWS is not supported — HTTPS is required'));
    }

    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(envelope)
      },
      rejectUnauthorized: true,
      timeout: 15000
    };

    const req = https.request(opts, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`EWS HTTP error ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));
        }
        if (body.includes('<s:Fault>') || body.includes('<soap:Fault>')) {
          const faultStr = xval(body, 'faultstring') || xval(body, 'Message') || 'SOAP Fault returned by Exchange server';
          return reject(new Error(`EWS Fault: ${faultStr}`));
        }
        resolve(body);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('EWS request timed out'));
    });

    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

async function ewsFolders(creds) {
  const soap = `
<m:FindFolder Traversal="Shallow">
  <m:FolderShape>
    <t:BaseShape>IdOnly</t:BaseShape>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="folder:DisplayName"/>
    </t:AdditionalProperties>
  </m:FolderShape>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="msgfolderroot"/>
  </m:ParentFolderIds>
</m:FindFolder>`;

  const xml = await ewsReq(creds, soap);
  const base = [
    { path: 'inbox', name: 'Inbox' },
    { path: 'sentitems', name: 'Sent Items' },
    { path: 'drafts', name: 'Drafts' },
    { path: 'deleteditems', name: 'Deleted Items' }
  ];

  const blocks = xml.match(/<t:Folder>[\s\S]*?<\/t:Folder>/g) || [];
  const baseNames = new Set(base.map(f => f.name.toLowerCase()));
  const extra = blocks.map(b => {
    const name = xval(b, 'DisplayName');
    const pathMatch = b.match(/FolderId\s+Id="([^"]+)"/) || b.match(/Id="([^"]+)"/);
    return name ? { path: pathMatch?.[1] || name, name } : null;
  }).filter(f => f && !baseNames.has(f.name.toLowerCase()));

  return [...base, ...extra];
}

async function ewsMessages(creds, folder, page, limit) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(50, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;
  const safeFolderId = escapeXmlAttr(folder);

  const soap = `
<m:FindItem Traversal="Shallow">
  <m:ItemShape>
    <t:BaseShape>IdOnly</t:BaseShape>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="message:From"/>
      <t:FieldURI FieldURI="item:Subject"/>
      <t:FieldURI FieldURI="item:DateTimeReceived"/>
      <t:FieldURI FieldURI="message:IsRead"/>
    </t:AdditionalProperties>
  </m:ItemShape>
  <m:IndexedPageItemView MaxEntriesReturned="${safeLimit}" Offset="${offset}" BasePoint="Beginning"/>
  <m:SortOrder>
    <t:FieldOrder Order="Descending">
      <t:FieldURI FieldURI="item:DateTimeReceived"/>
    </t:FieldOrder>
  </m:SortOrder>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="${safeFolderId}"/>
  </m:ParentFolderIds>
</m:FindItem>`;

  const xml = await ewsReq(creds, soap);
  const blocks = xml.match(/<t:Message>[\s\S]*?<\/t:Message>/g) || [];
  const messages = blocks.map(b => {
    const name = xval(b, 'Name');
    const email = xval(b, 'EmailAddress');
    const fromStr = name && email ? `${name} <${email}>` : name || email;

    return {
      uid: b.match(/ItemId\s+Id="([^"]+)"/)?.[1] || b.match(/Id="([^"]+)"/)?.[1] || '',
      seq: 0,
      seen: xval(b, 'IsRead') === 'true',
      subject: xval(b, 'Subject') || '(no subject)',
      from: fromStr,
      date: xval(b, 'DateTimeReceived') ? new Date(xval(b, 'DateTimeReceived')).toISOString() : null
    };
  });

  const totalMatch = xml.match(/TotalItemsInView="(\d+)"/);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : messages.length;
  const pages = Math.ceil(total / safeLimit) || 1;

  return { messages, total, page: safePage, pages };
}

async function ewsMessage(creds, uid, msgShape) {
  const safeUid = escapeXmlAttr(uid);
  const soap = `
<m:GetItem>
  <m:ItemShape>
    <t:BaseShape>Default</t:BaseShape>
    <t:IncludeMimeContent>true</t:IncludeMimeContent>
  </m:ItemShape>
  <m:ItemIds><t:ItemId Id="${safeUid}"/></m:ItemIds>
</m:GetItem>`;

  const xml = await ewsReq(creds, soap);
  const mime = xval(xml, 'MimeContent');

  if (mime && PostalMime) {
    const parser = new PostalMime();
    const parsed = await parser.parse(Buffer.from(mime, 'base64'));
    return typeof msgShape === 'function' ? msgShape(parsed) : {
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      date: parsed.date instanceof Date ? parsed.date.toISOString() : null,
      text: parsed.text || '',
      html: parsed.html || null,
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename,
        contentType: a.contentType || a.mimeType,
        size: a.size || 0
      }))
    };
  }

  const fallback = {
    subject: xval(xml, 'Subject') || '(no subject)',
    from: xval(xml, 'EmailAddress') || xval(xml, 'Name'),
    to: '',
    cc: '',
    date: xval(xml, 'DateTimeReceived') ? new Date(xval(xml, 'DateTimeReceived')).toISOString() : null,
    text: xval(xml, 'Body') || '',
    html: null,
    attachments: []
  };

  return typeof msgShape === 'function' ? msgShape(fallback) : fallback;
}

async function ewsMarkRead(creds, uids) {
  if (!Array.isArray(uids) || uids.length === 0) return;
  const itemChanges = uids.map(uid => `
    <t:ItemChange>
      <t:ItemId Id="${escapeXmlAttr(uid)}"/>
      <t:Updates>
        <t:SetItemField>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:Message><t:IsRead>true</t:IsRead></t:Message>
        </t:SetItemField>
      </t:Updates>
    </t:ItemChange>`).join('');
  const soap = `
<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AutoResolve">
  <m:ItemChanges>${itemChanges}</m:ItemChanges>
</m:UpdateItem>`;
  const response = await ewsReq(creds, soap);
  if (/ResponseClass="Error"/i.test(response)) {
    throw new Error(xval(response, 'MessageText') || 'Exchange could not mark the selected messages as read');
  }
}

module.exports = {
  setDependencies,
  ewsFolders,
  ewsMessages,
  ewsMessage,
  ewsMarkRead,
};