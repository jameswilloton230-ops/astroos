import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import https from 'node:https';

// ewsClient captures `const https = require('https')` at load — the same
// namespace object we patch here. vi.mock() cannot reliably intercept builtin
// requires for CJS modules under the current runner, so we swap https.request
// directly (restored after the file finishes). Each vitest worker has its own
// module registry, so the patch never leaks into other test files.
const httpsState = {
  lastOpts: null,
  lastBody: '',
  responder: null,
};

const realRequest = https.request;
function fakeRequest(opts, cb) {
  httpsState.lastOpts = opts;
  httpsState.lastBody = '';
  const req = new PassThrough();
  req.on('data', (c) => { httpsState.lastBody += c; });
  req.setEncoding('utf8');
  process.nextTick(() => {
    const respond = httpsState.responder;
    if (!respond) {
      req.emit('error', new Error('no responder configured'));
      return;
    }
    respond(cb);
  });
  return req;
}

Object.defineProperty(https, 'request', { value: fakeRequest, configurable: true, writable: true });

const ewsClient = await import('../../email/protocols/ewsClient.js');

class FakePostalMime {
  async parse(raw) {
    // raw is the Buffer the caller built from the base64 MimeContent
    return { subject: 'mime:' + raw.toString('utf8'), from: { text: 'mime-from' }, html: '<p>m</p>' };
  }
}

function xmlResponder(xml, statusCode = 200, statusMessage = 'OK') {
  return (cb) => {
    const res = new PassThrough();
    res.statusCode = statusCode;
    res.statusMessage = statusMessage;
    cb(res);
    res.end(xml);
  };
}

const CREDS = { host: 'mail.example.com', user: 'u', pass: 'p' };

beforeAll(() => {
  ewsClient.setDependencies({ PostalMime: FakePostalMime });
});

afterAll(() => {
  Object.defineProperty(https, 'request', { value: realRequest, configurable: true, writable: true });
  ewsClient.setDependencies({});
});

beforeEach(() => {
  httpsState.responder = xmlResponder('<xml/>');
});

describe('email/protocols/ewsClient.js — request plumbing', () => {
  it('rejects missing EWS credentials before any network activity', async () => {
    await expect(ewsClient.ewsFolders({})).rejects.toThrow('Missing EWS credentials');
    await expect(ewsClient.ewsFolders({ host: 'x', user: 'u' })).rejects.toThrow('Missing EWS credentials');
  });

  it('forces https and appends the EWS endpoint path; sends Basic auth', async () => {
    httpsState.responder = xmlResponder('<xml/>');
    await ewsClient.ewsFolders({ ...CREDS, host: 'http://mail.example.com' });
    expect(httpsState.lastOpts.hostname).toBe('mail.example.com');
    expect(httpsState.lastOpts.port).toBe(443);
    expect(httpsState.lastOpts.path).toBe('/EWS/Exchange.asmx');
    expect(httpsState.lastOpts.headers.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    expect(httpsState.lastOpts.headers['Content-Type']).toContain('text/xml');

    await ewsClient.ewsFolders({ ...CREDS, host: 'https://mail.example.com/ews' });
    expect(httpsState.lastOpts.path).toBe('/ews/EWS/Exchange.asmx');
  });

  it('rejects hosts that are not valid URLs', async () => {
    await expect(ewsClient.ewsFolders({ ...CREDS, host: 'http://exa mple.com' })).rejects.toThrow('Invalid EWS host URL');
  });

  it('surfaces non-2xx responses as EWS HTTP errors', async () => {
    httpsState.responder = xmlResponder('nope', 503, 'Service Unavailable');
    await expect(ewsClient.ewsFolders(CREDS)).rejects.toThrow('EWS HTTP error 503: Service Unavailable');
  });

  it('extracts SOAP faults into readable errors', async () => {
    httpsState.responder = xmlResponder('<s:Envelope><s:Fault><faultstring>Mailbox quota exceeded</faultstring></s:Fault></s:Envelope>');
    await expect(ewsClient.ewsFolders(CREDS)).rejects.toThrow('EWS Fault: Mailbox quota exceeded');
  });

  it('includes the SOAP envelope and the caller body in the request', async () => {
    await ewsClient.ewsFolders(CREDS);
    expect(httpsState.lastBody).toContain('<soap:Envelope');
    expect(httpsState.lastBody).toContain('FindFolder');
  });
});

describe('email/protocols/ewsClient.js — ewsFolders', () => {
  it('returns the four base folders plus parsed extras (deduped, entities decoded)', async () => {
    httpsState.responder = xmlResponder(`
      <m:FindFolderResponse>
        <t:Folder><t:DisplayName>Projects</t:DisplayName><t:FolderId Id="abc-123"/></t:Folder>
        <t:Folder><t:DisplayName>Inbox</t:DisplayName></t:Folder>
        <t:Folder><t:DisplayName>Sales &amp; Marketing</t:DisplayName><FolderId Id="xyz-9"/></t:Folder>
      </m:FindFolderResponse>`);
    const folders = await ewsClient.ewsFolders(CREDS);
    const base = folders.slice(0, 4).map((f) => f.name);
    expect(base).toEqual(['Inbox', 'Sent Items', 'Drafts', 'Deleted Items']);
    // 3 XML blocks: "Inbox" dedupes against the base list, the other two are extras
    expect(folders).toHaveLength(6);
    expect(folders[4]).toEqual({ path: 'abc-123', name: 'Projects' });
    expect(folders[5].name).toBe('Sales & Marketing');
  });
});

describe('email/protocols/ewsClient.js — ewsMessages', () => {
  it('parses message blocks with pagination metadata', async () => {
    httpsState.responder = xmlResponder(`
      <m:FindItemResponse TotalItemsInView="3">
        <t:Message>
          <t:ItemId Id="item-7"/>
          <t:From><t:Mailbox><t:Name>Alice</t:Name><t:EmailAddress>alice@x.com</t:EmailAddress></t:Mailbox></t:From>
          <t:Subject>Hello &amp; welcome</t:Subject>
          <t:IsRead>true</t:IsRead>
          <t:DateTimeReceived>2026-01-02T03:04:05Z</t:DateTimeReceived>
        </t:Message>
      </m:FindItemResponse>`);
    const res = await ewsClient.ewsMessages(CREDS, 'inbox', 1, 20);
    expect(res.total).toBe(3);
    expect(res.pages).toBe(1);
    expect(res.page).toBe(1);
    expect(res.messages[0].uid).toBe('item-7');
    expect(res.messages[0].from).toBe('Alice <alice@x.com>');
    expect(res.messages[0].subject).toBe('Hello & welcome');
    expect(res.messages[0].seen).toBe(true);
    expect(res.messages[0].date).toBe('2026-01-02T03:04:05.000Z');
  });

  it('clamps page/limit into safe ranges and escapes the folder id in SOAP', async () => {
    await ewsClient.ewsMessages(CREDS, 'inbox', 0, 3);
    expect(httpsState.lastBody).toContain('MaxEntriesReturned="5"');
    expect(httpsState.lastBody).toContain('Offset="0"');

    await ewsClient.ewsMessages(CREDS, 'in box"><x>', 2, 999);
    expect(httpsState.lastBody).toContain('MaxEntriesReturned="50"');
    expect(httpsState.lastBody).toContain('Offset="50"');
    expect(httpsState.lastBody).toContain('Id="in box&quot;&gt;&lt;x&gt;"');
  });

  it('falls back to the message count when TotalItemsInView is absent', async () => {
    httpsState.responder = xmlResponder('<m:FindItemResponse><t:Message><t:ItemId Id="a"/><t:Subject>s</t:Subject></t:Message></m:FindItemResponse>');
    const res = await ewsClient.ewsMessages(CREDS, 'inbox', 1, 5);
    expect(res.total).toBe(1);
    expect(res.pages).toBe(1);
  });
});

describe('email/protocols/ewsClient.js — ewsMessage', () => {
  it('parses base64 MimeContent through PostalMime and applies msgShape', async () => {
    const mime = Buffer.from('SUBJECT RAW').toString('base64');
    httpsState.responder = xmlResponder(`<m:GetItemResponse><t:MimeContent>${mime}</t:MimeContent></m:GetItemResponse>`);
    const shape = (p) => ({ subject: p.subject, html: p.html });
    const msg = await ewsClient.ewsMessage(CREDS, 'item-1', shape);
    expect(msg.subject).toBe('mime:SUBJECT RAW');
    expect(msg.html).toBe('<p>m</p>');
  });

  it('falls back to XML fields when no MimeContent is present', async () => {
    httpsState.responder = xmlResponder(`
      <m:GetItemResponse>
        <t:Subject>Fallback subject</t:Subject>
        <t:From><t:Mailbox><t:EmailAddress>fb@x.com</t:EmailAddress></t:Mailbox></t:From>
        <t:Body>Plain body</t:Body>
      </m:GetItemResponse>`);
    const msg = await ewsClient.ewsMessage(CREDS, 'item-2', (p) => p);
    expect(msg.subject).toBe('Fallback subject');
    expect(msg.from).toBe('fb@x.com');
    expect(msg.text).toBe('Plain body');
    expect(msg.html).toBeNull();
    expect(msg.attachments).toEqual([]);
  });
});

describe('email/protocols/ewsClient.js — ewsMarkRead', () => {
  it('sends one ItemChange per uid and resolves on success', async () => {
    await ewsClient.ewsMarkRead(CREDS, ['a', 'b']);
    expect(httpsState.lastBody).toContain('UpdateItem');
    expect((httpsState.lastBody.match(/<t:ItemChange>/g) || []).length).toBe(2);
    expect(httpsState.lastBody).toContain('Id="a"');
    expect(httpsState.lastBody).toContain('Id="b"');
  });

  it('throws the server MessageText when the response reports an error', async () => {
    httpsState.responder = xmlResponder('<m:UpdateItemResponse><m:ResponseMessages><m:UpdateItemResponseMessage ResponseClass="Error"><m:MessageText>Item was moved</m:MessageText></m:UpdateItemResponseMessage></m:ResponseMessages></m:UpdateItemResponse>');
    await expect(ewsClient.ewsMarkRead(CREDS, ['a'])).rejects.toThrow('Item was moved');
  });

  it('returns early for an empty uid list without any request', async () => {
    httpsState.responder = () => { throw new Error('should not be called'); };
    await expect(ewsClient.ewsMarkRead(CREDS, [])).resolves.toBeUndefined();
  });
});
