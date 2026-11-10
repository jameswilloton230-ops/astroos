import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

// Multi-candidate DNS resolution + pinned fetch in server/proxies.js.
//
// The proxy pins every outbound connection to an IP it validated (SSRF /
// DNS-rebinding protection). Node's single-address lookup in OS-preference
// order frequently returns an IPv6 address first; on hosts without a working
// IPv6 route every pinned connect threw and the whole proxy 502'd even though
// the IPv4 path was fine — the ":3003/api/proxy 502" reports. The fix resolves
// ALL addresses, fails closed if ANY of them is private, orders IPv4 first,
// and tries candidates in order before giving up.
//
// Injection note: `dns` and `undici` are process-wide singletons and
// proxies.js reaches them through property access at call time (see
// undiciModules()), so we stub them here with vi.spyOn / direct assignment on
// the same objects — vi.mock would not be seen through the CJS require.

const require = createRequire(import.meta.url);
const dns = require('node:dns');
const undici = require('undici');

import proxies from '../../server/proxies.js';
const { _dnsResolvePrivate, _pinnedFetch, _dnsPrivateCache } = proxies._internal;

// A host whose "DNS" says: one public IPv6 first (what verbatim order looks
// like on dual-stack hosts), one public IPv4 second.
const DUAL_STACK = [
  { address: '2606:4700::6810:84e5', family: 6 },
  { address: '104.26.11.35', family: 4 },
];

const originalLookup = dns.promises.lookup;
const originalFetch = undici.fetch;
const originalAgent = undici.Agent;

describe('proxies.js — multi-candidate SSRF resolution and pinned fetch', () => {
  let lookupMock;
  let fetchMock;

  beforeEach(() => {
    lookupMock = vi.fn();
    dns.promises.lookup = lookupMock;
    fetchMock = vi.fn();
    undici.fetch = fetchMock;
    // Minimal stand-in that records its connect options (incl. the pinned
    // lookup override) so tests can assert the IP pinning contract.
    undici.Agent = class FakeAgent {
      constructor(opts) {
        this.opts = opts;
      }
      close() {
        return Promise.resolve();
      }
    };
  });

  afterEach(() => {
    dns.promises.lookup = originalLookup;
    undici.fetch = originalFetch;
    undici.Agent = originalAgent;
    _dnsPrivateCache.clear();
  });

  describe('_dnsResolvePrivate', () => {
    it('orders public candidates IPv4-first regardless of lookup order', async () => {
      lookupMock.mockResolvedValueOnce(DUAL_STACK);
      const d = await _dnsResolvePrivate('dual.example');
      expect(d.private).toBe(false);
      expect(d.addresses.map((a) => a.family)).toEqual([4, 6]);
      expect(d.address).toBe('104.26.11.35');
      expect(d.family).toBe(4);
      expect(lookupMock).toHaveBeenCalledWith('dual.example', { all: true, verbatim: true });
    });

    it('fails closed when ANY resolved address is private (multi-address dodge)', async () => {
      lookupMock.mockResolvedValueOnce([
        { address: '104.26.11.35', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ]);
      const d = await _dnsResolvePrivate('mixed.example');
      expect(d.private).toBe(true);
      expect(d.addresses).toEqual([]);
    });

    it('fails closed when the lookup returns no addresses', async () => {
      lookupMock.mockResolvedValueOnce([]);
      const d = await _dnsResolvePrivate('empty.example');
      expect(d.private).toBe(true);
      expect(d.addresses).toEqual([]);
    });

    it('fails closed when the lookup rejects', async () => {
      lookupMock.mockRejectedValueOnce(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      const d = await _dnsResolvePrivate('missing.example');
      expect(d.private).toBe(true);
      expect(d.addresses).toEqual([]);
    });

    it('dedupes repeated addresses from the resolver', async () => {
      lookupMock.mockResolvedValueOnce([
        { address: '104.26.11.35', family: 4 },
        { address: '104.26.11.35', family: 4 },
        { address: '2606:4700::6810:84e5', family: 6 },
      ]);
      const d = await _dnsResolvePrivate('dupe.example');
      expect(d.addresses).toHaveLength(2);
    });

    it('caches results for the TTL window', async () => {
      lookupMock.mockResolvedValue([{ address: '104.26.11.35', family: 4 }]);
      await _dnsResolvePrivate('cached.example');
      await _dnsResolvePrivate('cached.example');
      expect(lookupMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('_pinnedFetch', () => {
    it('falls through to the next validated candidate when the first connect fails', async () => {
      lookupMock.mockResolvedValueOnce(DUAL_STACK);
      const d = await _dnsResolvePrivate('fallback.example');
      const okResponse = { ok: true, status: 200, marker: 'ipv4' };
      fetchMock
        .mockRejectedValueOnce(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }))
        .mockResolvedValueOnce(okResponse);

      const resp = await _pinnedFetch('https://fallback.example/x', {}, d);
      expect(resp.marker).toBe('ipv4');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Each attempt gets its own pinned Agent carrying the candidate IP.
      expect(fetchMock.mock.calls[0][1].dispatcher.opts.connect.lookup).toBeTypeOf('function');
    });

    it('throws the last error when every candidate fails', async () => {
      lookupMock.mockResolvedValueOnce(DUAL_STACK);
      const d = await _dnsResolvePrivate('alldown.example');
      fetchMock
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));

      await expect(_pinnedFetch('https://alldown.example/x', {}, d))
        .rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses to fetch a private/failed resolution (SSRF guard kept)', async () => {
      lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
      const d = await _dnsResolvePrivate('internal.example');
      await expect(_pinnedFetch('https://internal.example/', {}, d))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to fetch with no validated candidates', async () => {
      await expect(_pinnedFetch('https://x.example/', {}, { private: false, addresses: [] }))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      await expect(_pinnedFetch('https://x.example/', {}, null))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    it('pins each attempt to exactly the validated candidate address', async () => {
      lookupMock.mockResolvedValueOnce([{ address: '104.26.11.35', family: 4 }]);
      const d = await _dnsResolvePrivate('pin.example');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      await _pinnedFetch('https://pin.example/', {}, d);

      const agent = fetchMock.mock.calls[0][1].dispatcher;
      // The Agent's connect lookup override must only ever hand out the
      // validated IP — that is the whole DNS-rebinding guarantee.
      agent.opts.connect.lookup('pin.example', {}, (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual([{ address: '104.26.11.35', family: 4 }]);
      });
    });
  });
});
