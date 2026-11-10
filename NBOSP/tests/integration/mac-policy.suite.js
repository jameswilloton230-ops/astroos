'use strict';
// NB-MAC (mandatory access control) test suite.
//
// Loads the REAL app-sandbox.js over the shared env helpers and verifies:
//   M1  seed policy shape + coverage of every registered handler
//   M2  grant-coupled enforcement over the bridge (denied/granted parity)
//   M3  advisory passthrough parity (storage, owned fs, unknown API, guests)
//   M4  default-deny for endpoints with no policy row (custom policy)
//   M5  permissive mode: would-be denials audited, handler stays boundary
//   M6  subject pinning (seapp_contexts analog)
//   M7  verifyPolicy/neverallow rejections
//   M8  audit ring, rate limit, snapshot, cleanup
//
// Usage: node tests/test_mac_policy.js [--verbose]

const env = require('../helpers/env');
const { AppSandbox, AppPermissionManager: PM, makeApp, makeWebview, makeSandbox, call, grant, revoke, resetHost } = env;

global.AppSandbox = AppSandbox;

const MAC = AppSandbox.macPolicy;
const API_HANDLERS = AppSandbox._internal.API_HANDLERS;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }
const code = (r) => r?.error?.code ?? null;

function freshModule() {
  MAC._resetForTests();
  resetHost();
  try { localStorage.removeItem('novaOS_mac_audit'); } catch (e) { /* fake-fs ok */ }
}

function seedPolicyCopy() {
  return JSON.parse(JSON.stringify(MAC.DEFAULT_POLICY));
}

async function main() {

// ════════════════════ M1: seed policy + coverage ════════════════════

section('M1: seed policy + handler coverage');

freshModule();

const info0 = MAC.getPolicyInfo();
check('policy version is 1', info0.policyVersion === 1, String(info0.policyVersion));
check('untrusted_app defaults to enforcing', info0.domains.untrusted_app === 'enforcing');
check('platform_module defaults to permissive', info0.domains.platform_module === 'permissive');
check('grant-coupled endpoints present', info0.grantCoupledEndpoints >= 40, String(info0.grantCoupledEndpoints));
check('advisory rows present', info0.advisoryEndpoints >= 15, String(info0.advisoryEndpoints));
check('advisory families present', info0.advisoryFamilies >= 15, String(info0.advisoryFamilies));
check('neverallow rules present', info0.neverallow >= 1, String(info0.neverallow));

const cov = MAC.verifyCoverage(Object.keys(API_HANDLERS));
check('every registered handler is covered by policy', cov.ok, cov.uncovered.join(', '));
check('coverage rejects a made-up endpoint', !MAC.verifyCoverage(['nova:future:thing']).ok);

check('domainFor defaults to untrusted_app', MAC.domainFor('com.some.app') === 'untrusted_app');
check('domainFor handles empty id', MAC.domainFor('') === 'untrusted_app');

// Pure enforcer: an unknown endpoint type is default-deny (no rule).
const pureDeny = MAC.checkIpc('com.some.app', 'nova:future:thing');
check('no-rule endpoint denied for enforcing domain', pureDeny.allowed === false && pureDeny.noRule === true, JSON.stringify(pureDeny));
check('no-rule denial carries PERMISSION_DENIED code', pureDeny.code === 'PERMISSION_DENIED');

// ════════════════════ M2: grant-coupled enforcement ════════════════════

section('M2: grant-coupled enforcement over the bridge');

const A = 'macappA';

const deniedApp = makeApp(A);
resetHost();
MAC._resetForTests();

// Without grant: MAC refuses with the same code handlers produce.
let r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('notifications:show denied without grant', code(r) === 'PERMISSION_DENIED', code(r));
check('MAC denial message identifies the layer', String(r?.error?.message || '').startsWith('Blocked by system security policy (MAC)'), r?.error?.message);
check('MAC denial names the required grant', String(r?.error?.message || '').includes('device:notifications'), r?.error?.message);

r = await call('nova:clipboard:read', {}, { appId: A });
check('clipboard:read denied without grant', code(r) === 'PERMISSION_DENIED', code(r));

// With grant: MAC passes, handler proceeds.
await grant('device:notifications', A);
r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('notifications:show allowed with grant', code(r) !== 'PERMISSION_DENIED', code(r) || String(r?.result?.success));
await revoke('device:notifications', A);

await grant('clipboard:read', A);
r = await call('nova:clipboard:read', {}, { appId: A });
check('clipboard:read allowed with grant', code(r) !== 'PERMISSION_DENIED', code(r));
await revoke('clipboard:read', A);

// ANY-of semantics (matches handler logic for launch).
await grant('system:apps', A);
r = await call('nova:app:list', {}, { appId: A });
check('app:list allowed with ANY-of grant (system:apps only)', code(r) !== 'PERMISSION_DENIED', code(r));
await revoke('system:apps', A);

// Enforced denial was audited with avc line.
const audit1 = MAC.getAudit(10);
check('denial audited', audit1.some((e) => e.endpoint === 'nova:notifications:show' && e.enforced === true), JSON.stringify(audit1[0] || {}));
check('audit entry carries avc line', String(audit1[0]?.avc || '').startsWith('avc: denied { call }'), audit1[0]?.avc);

// ════════════════════ M3: advisory passthrough parity ════════════════════

section('M3: advisory passthrough parity');

// Storage family is advisory: no grants needed, handler owns the boundary.
r = await call('nova:storage:set', { key: 'k', value: 'v' }, { appId: A });
check('storage:set passes MAC with zero grants', r.result?.success === true, code(r));
r = await call('nova:storage:get', { key: 'k' }, { appId: A });
check('storage:get round-trips (advisory family)', r.result?.value === 'v', code(r));

// Owned fs paths with zero grants still work (path-dependent gate is
// handler-level — the policy keeps fs rows advisory).
const FS = env.state.FS;
const data = FS.getByPath('/data');
if (!FS.listDir(data.id).find((n) => n.name === A)) await FS.createFolder(data.id, A);
r = await call('nova:fs:write', { path: '/data/note.txt', content: 'own-data' }, { appId: A });
check('owned fs path writable with zero grants (fs advisory)', r.result?.success === true || code(r) === null, code(r) || 'ok');

// Unknown API still UNKNOWN_API (handler lookup precedes MAC).
r = await call('nova:totally:made-up', {});
check('unknown API still UNKNOWN_API', code(r) === 'UNKNOWN_API', code(r));

// ════════════════════ M4: default-deny no-policy-row ════════════════════

section('M4: default-deny for endpoints with no policy row');

const reduced = seedPolicyCopy();
delete reduced.endpointGrants['nova:notifications:show'];
MAC.applyPolicy(reduced);

const covGap = MAC.verifyCoverage(['nova:notifications:show']);
check('verifyCoverage flags the dropped row', covGap.ok === false && covGap.uncovered.includes('nova:notifications:show'));

r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('rowless endpoint denied even with grant held', code(r) === 'PERMISSION_DENIED', code(r));
await grant('device:notifications', A);
r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('grant does not bypass a missing policy row', code(r) === 'PERMISSION_DENIED', code(r));
check('rowless denial message says no policy rule', String(r?.error?.message || '').includes('no policy rule'), r?.error?.message);
await revoke('device:notifications', A);

const auditNoRule = MAC.getAudit(5);
check('rowless denial audited with noRule', auditNoRule.some((e) => e.noRule === true && e.endpoint === 'nova:notifications:show'), JSON.stringify(auditNoRule[0] || {}));

// Restore seed policy.
MAC.applyPolicy(seedPolicyCopy());
r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('seed policy restored — denial returns', code(r) === 'PERMISSION_DENIED', code(r));
const covRestored = MAC.verifyCoverage(Object.keys(API_HANDLERS));
check('coverage restored', covRestored.ok, covRestored.uncovered.join(', '));

// ════════════════════ M5: permissive mode ════════════════════

section('M5: permissive mode — log, do not enforce');

MAC.setDomainMode('untrusted_app', 'permissive');

r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('permissive: call reaches handler (still PERMISSION_DENIED from handler)', code(r) === 'PERMISSION_DENIED', code(r));
check('permissive: handler message, not MAC message', !String(r?.error?.message || '').startsWith('Blocked by system security policy'), r?.error?.message);

const auditPerm = MAC.getAudit(5);
check('permissive: would-be denial audited as non-enforced', auditPerm.some((e) => e.endpoint === 'nova:notifications:show' && e.enforced === false), JSON.stringify(auditPerm[0] || {}));

MAC.setDomainMode('untrusted_app', 'enforcing');
let threw = false;
try { MAC.setDomainMode('untrusted_app', 'bogus'); } catch (e) { threw = true; }
check('setDomainMode rejects unknown mode', threw);
threw = false;
try { MAC.setDomainMode('no.such.domain', 'enforcing'); } catch (e) { threw = true; }
check('setDomainMode rejects unknown domain', threw);

// ════════════════════ M6: subject pinning ════════════════════

section('M6: subject pinning (seapp_contexts analog)');

const pinned = seedPolicyCopy();
pinned.subjects[A] = 'platform_module'; // permissive domain
MAC.applyPolicy(pinned);
check('subject pinning changes domain', MAC.domainFor(A) === 'platform_module');

r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: A });
check('pinned-to-permissive app passes MAC (handler still gates)', code(r) === 'PERMISSION_DENIED', code(r));
check('pinned denial is handler-level, not MAC', !String(r?.error?.message || '').startsWith('Blocked by system security policy'), r?.error?.message);

const auditPinned = MAC.getAudit(3);
check('pinned would-be denial audited', auditPinned.some((e) => e.appId === A && e.enforced === false && e.domain === 'platform_module'), JSON.stringify(auditPinned[0] || {}));

// Other apps stay in the enforcing domain.
const other = makeApp('macappB');
resetHost();
MAC._resetForTests();
r = await call('nova:notifications:show', { title: 't', body: 'b' }, { appId: 'macappB' });
check('unpinned app still enforced after pinning existed', code(r) === 'PERMISSION_DENIED', code(r));
check('unpinned denial IS MAC-level', String(r?.error?.message || '').startsWith('Blocked by system security policy'), r?.error?.message);

// ════════════════════ M7: policy linting / neverallow ════════════════════

section('M7: verifyPolicy + neverallow rejections');

let bad = seedPolicyCopy();
bad.domains.untrusted_app.mode = 'bogus';
let v = MAC.verifyPolicy(bad);
check('invalid domain mode rejected', !v.ok && v.errors.some((e) => e.includes('mode')), JSON.stringify(v.errors));

bad = seedPolicyCopy();
bad.subjects['com.x'] = 'missing_domain';
v = MAC.verifyPolicy(bad);
check('subject pinning to unknown domain rejected', !v.ok && v.errors.some((e) => e.includes('missing_domain')), JSON.stringify(v.errors));

bad = seedPolicyCopy();
bad.endpointGrants['nova:admin:audit'] = null;
v = MAC.verifyPolicy(bad);
check('neverallow: advisory admin row rejected', !v.ok && v.errors.some((e) => e.includes('neverallow')), JSON.stringify(v.errors));

bad = seedPolicyCopy();
delete bad.endpointGrants['nova:admin:audit'];
// A DROPPED row is not a neverallow violation (absence of a rule = deny =
// stricter, true SELinux semantics) — it is a COVERAGE violation, which
// verifyPolicy cannot see (it does not know the handler table). The
// composite guarantee: apply it, then coverage must flag the gap.
MAC.applyPolicy(bad);
const covDropped = MAC.verifyCoverage(Object.keys(API_HANDLERS));
check('neverallow: dropped admin row caught by coverage', !covDropped.ok && covDropped.uncovered.includes('nova:admin:audit'), JSON.stringify(covDropped.uncovered));
MAC.applyPolicy(seedPolicyCopy());

bad = seedPolicyCopy();
bad.advisoryFamilies.push('nova:admin');
v = MAC.verifyPolicy(bad);
check('neverallow: advisory admin family rejected', !v.ok && v.errors.some((e) => e.includes('nova:admin')), JSON.stringify(v.errors));

bad = seedPolicyCopy();
bad.endpointGrants['nova:clipboard:read'] = [];
v = MAC.verifyPolicy(bad);
check('empty grant array rejected', !v.ok, JSON.stringify(v.errors));

threw = false;
try { MAC.applyPolicy(bad); } catch (e) { threw = e.policyErrors && e.policyErrors.length > 0; }
check('applyPolicy throws with policyErrors on invalid policy', threw);

v = MAC.verifyPolicy(null);
check('null policy rejected', !v.ok);
v = MAC.verifyPolicy(seedPolicyCopy());
check('seed policy passes its own lint', v.ok, JSON.stringify(v.errors));

// ════════════════════ M8: audit ring, rate limit, snapshot ════════════════════

section('M8: audit ring, rate limit, snapshot, cleanup');

freshModule();
MAC.applyPolicy(seedPolicyCopy());

// Hammer denials for one app to trip the audit write rate limit.
for (let i = 0; i < 70; i++) {
  await call('nova:clipboard:read', {}, { appId: 'macflood' });
}
const floodInfo = MAC.getPolicyInfo();
check('audit rate limit drops excess entries', floodInfo.auditDropped >= 1, String(floodInfo.auditDropped));
check('audit ring capped (300 max)', floodInfo.auditEntries <= 300, String(floodInfo.auditEntries));
check('denialsToday counts enforced denials', floodInfo.denialsToday >= 1, String(floodInfo.denialsToday));

const snap = await AppSandbox.macPolicySnapshot();
check('snapshot exposes policy info', !!snap.info && typeof snap.info.grantCoupledEndpoints === 'number');
check('snapshot exposes denial feed', Array.isArray(snap.denials) && snap.denials.length > 0, String(snap.denials?.length));
check('denial feed entries shaped for Settings', snap.denials.every((d) => typeof d.t === 'number' && typeof d.endpoint === 'string' && typeof d.enforced === 'boolean'));

MAC.clearAudit();
check('clearAudit empties the feed', MAC.getAudit(10).length === 0 && MAC.getPolicyInfo().auditEntries === 0);

// ═══════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}

}

main().catch((e) => { console.error(e); process.exit(1); });
