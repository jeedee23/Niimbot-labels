import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createWorker } from '../worker.mjs';

const inventory = JSON.parse(await readFile(new URL('../drawers.json', import.meta.url), 'utf8'));
const keys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey);
jwk.kid = 'test-key';
jwk.alg = 'RS256';
const signingKeys = createLocalJWKSet({ keys: [jwk] });
const origin = 'https://niimbot-labels.example';
const env = {
  ACCESS_ISSUER: 'https://test-team.cloudflareaccess.com',
  ACCESS_AUD: 'a'.repeat(64),
  GITHUB_REPOSITORY: 'test-owner/test-repository',
  GITHUB_BRANCH: 'main',
  GITHUB_TOKEN: 'test-only-not-a-real-token'
};

async function token(claims = {}, signingKey = keys.privateKey) {
  return new SignJWT({ email: 'owner@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(claims.iss || env.ACCESS_ISSUER)
    .setAudience(claims.aud || env.ACCESS_AUD)
    .setSubject('test-user')
    .setIssuedAt()
    .setExpirationTime(claims.exp || '1h')
    .sign(signingKey);
}

const validToken = await token();

function fixture() {
  let remote = structuredClone(inventory);
  let version = 1;
  const sha = () => version.toString(16).padStart(40, '0');
  const calls = [];
  let beforePut;
  const fetchGitHub = async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/test-owner/test-repository/contents/drawers.json'));
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.redirect, 'manual');
    calls.push({ url, options });
    if (options.method === 'PUT') {
      if (beforePut) {
        const action = beforePut;
        beforePut = undefined;
        action(remote);
        version++;
      }
      const payload = JSON.parse(options.body);
      if (payload.sha !== sha()) return Response.json({ message: 'sha conflict' }, { status: 409 });
      assert.equal(payload.branch, 'main');
      assert.match(payload.message, /Co-authored-by: Copilot/);
      remote = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
      version++;
      return Response.json({ content: { sha: sha() } });
    }
    assert.equal(new URL(url).searchParams.get('ref'), 'main');
    return Response.json({
      type: 'file', encoding: 'base64', sha: sha(),
      content: Buffer.from(JSON.stringify(remote)).toString('base64')
    });
  };
  const worker = createWorker({ fetchGitHub, signingKeys });
  return {
    worker, calls,
    remote: () => remote,
    race(action) { beforePut = action; },
    get(assertion = validToken, environment = env) {
      return worker.fetch(new Request(`${origin}/api/drawers`, {
        headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}
      }), environment);
    },
    patch(payload, { number = '101', assertion = validToken, requestOrigin = origin, contentType = 'application/json' } = {}) {
      return worker.fetch(new Request(`${origin}/api/drawers/${number}`, {
        method: 'PATCH',
        headers: { 'Cf-Access-Jwt-Assertion': assertion, Origin: requestOrigin, 'Content-Type': contentType },
        body: JSON.stringify(payload)
      }), env);
    }
  };
}

test('verified Access login reads current GitHub data instead of a deployed snapshot', async () => {
  const f = fixture();
  f.remote()[100].title = 'Latest repository title';
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.readOnly, false);
  assert.equal(result.drawers.length, 210);
  assert.equal(result.drawers[100].title, 'Latest repository title');
  assert.match(result.revision, /^[a-f0-9]{40}$/);
});

test('missing, malformed, expired and wrong-audience logins never reach GitHub', async () => {
  const otherKeys = await generateKeyPair('RS256');
  const f = fixture();
  for (const assertion of [
    null, 'forged', await token({ exp: Math.floor(Date.now() / 1000) - 60 }),
    await token({ aud: 'b'.repeat(64) }),
    await token({ iss: 'https://other-team.cloudflareaccess.com' }),
    await token({}, otherKeys.privateKey)
  ]) {
    const response = await f.get(assertion);
    assert.equal(response.status, 401);
    assert.ok((await response.json()).error);
  }
  assert.equal(f.calls.length, 0);
});

test('a signed token without user email is rejected', async () => {
  const f = fixture();
  assert.equal((await f.get(await token({ email: null }))).status, 403);
  assert.equal(f.calls.length, 0);
});

test('missing Access configuration or GitHub secret fails closed', async () => {
  const f = fixture();
  for (const config of [
    { ...env, ACCESS_AUD: '' }, { ...env, ACCESS_ISSUER: 'https://evil.example' },
    { ...env, GITHUB_TOKEN: '' }, { ...env, GITHUB_REPOSITORY: '' }
  ]) {
    const response = await f.get(validToken, config);
    assert.equal(response.status, 503);
    assert.ok((await response.json()).error);
  }
  assert.equal(f.calls.length, 0);
});

test('successful save commits exact spaces, Unicode, newlines and tag entries', async () => {
  const f = fixture();
  const old = structuredClone(f.remote()[100]);
  const changes = {
    title: '  M3  afstand \u00e9 \u{1f527}  ',
    description: 'first line \n second line  ',
    remark: 'remark  ',
    searchTag: [' M3 ', '', 'afstand  ']
  };
  const base = Object.fromEntries(Object.keys(changes).map(key => [key, old[key]]));
  const response = await f.patch({ base, changes });
  assert.equal(response.status, 200);
  const result = await response.json();
  for (const key of Object.keys(changes)) {
    assert.deepEqual(result.drawer[key], changes[key]);
    assert.deepEqual(f.remote()[100][key], changes[key]);
  }
  for (const key of ['number', 'position', 'photo', 'sourceLabel']) assert.equal(f.remote()[100][key], old[key]);
  assert.match(result.revision, /^[a-f0-9]{40}$/);
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('same-field changes conflict before a GitHub write', async () => {
  const f = fixture();
  const old = f.remote()[100].title;
  f.remote()[100].title = 'Other writer';
  const response = await f.patch({ base: { title: old }, changes: { title: 'My draft' } });
  assert.equal(response.status, 409);
  assert.equal(f.remote()[100].title, 'Other writer');
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 0);
});

test('a GitHub SHA race retries safely and retains unrelated edits', async () => {
  const f = fixture();
  const old = f.remote()[100].title;
  f.race(remote => {
    remote[100].remark = 'Another client remark';
    remote[101].description = 'Another drawer edited';
  });
  const response = await f.patch({ base: { title: old }, changes: { title: 'My new title' } });
  assert.equal(response.status, 200);
  assert.equal(f.remote()[100].title, 'My new title');
  assert.equal(f.remote()[100].remark, 'Another client remark');
  assert.equal(f.remote()[101].description, 'Another drawer edited');
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 2);
});

test('a SHA race on the edited field stops rather than overwrite the other writer', async () => {
  const f = fixture();
  const old = f.remote()[100].title;
  f.race(remote => { remote[100].title = 'Winner'; });
  const response = await f.patch({ base: { title: old }, changes: { title: 'Loser' } });
  assert.equal(response.status, 409);
  assert.equal(f.remote()[100].title, 'Winner');
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('different fields and drawers can save concurrently with SHA conflict retries', async () => {
  const f = fixture();
  const old = structuredClone(f.remote());
  const responses = await Promise.all([
    f.patch({ base: { title: old[100].title }, changes: { title: 'Concurrent title' } }),
    f.patch({ base: { remark: old[100].remark }, changes: { remark: 'Concurrent remark' } }),
    f.patch({ base: { description: old[101].description }, changes: { description: 'Other drawer' } }, { number: '102' })
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.equal(f.remote()[100].title, 'Concurrent title');
  assert.equal(f.remote()[100].remark, 'Concurrent remark');
  assert.equal(f.remote()[101].description, 'Other drawer');
});

test('cross-origin, wrong media type and invalid field edits are rejected before reading GitHub', async () => {
  const f = fixture();
  const payload = { base: { title: inventory[100].title }, changes: { title: 'Draft' } };
  assert.equal((await f.patch(payload, { requestOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await f.patch(payload, { requestOrigin: '' })).status, 403);
  assert.equal((await f.patch(payload, { contentType: 'text/plain' })).status, 415);
  for (const bad of [
    { base: {}, changes: { title: 'missing base' } },
    { base: { number: '101' }, changes: { number: '001' } },
    { base: { searchTag: [] }, changes: { searchTag: 'not array' } }
  ]) assert.equal((await f.patch(bad)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('malformed and oversized JSON bodies produce explicit errors without writes', async () => {
  const f = fixture();
  for (const [body, status] of [['{', 400], ['x'.repeat(530000), 413]]) {
    const response = await f.worker.fetch(new Request(`${origin}/api/drawers/101`, {
      method: 'PATCH',
      headers: { 'Cf-Access-Jwt-Assertion': validToken, Origin: origin, 'Content-Type': 'application/json' },
      body
    }), env);
    assert.equal(response.status, status);
    assert.ok((await response.json()).error);
  }
  assert.equal(f.calls.length, 0);
});

test('GitHub read failures are explicit and never return a success-shaped snapshot', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const worker = createWorker({
      signingKeys,
      fetchGitHub: async () => Response.json({ message: 'do not expose upstream body' }, { status })
    });
    const response = await worker.fetch(new Request(`${origin}/api/drawers`, {
      headers: { 'Cf-Access-Jwt-Assertion': validToken }
    }), env);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.ok(result.error);
    assert.equal(result.drawers, undefined);
    assert.ok(!JSON.stringify(result).includes('do not expose upstream body'));
    assert.ok(!JSON.stringify(result).includes(env.GITHUB_TOKEN));
  }
});

test('default fetch uses Cloudflare-supported manual redirects', async () => {
  const originalFetch = globalThis.fetch;
  let worker;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      // Workers supports only follow/manual; error mode throws before any HTTP response.
      if (options.redirect !== 'manual') throw new TypeError('Invalid redirect value.');
      return Response.json({
        type: 'file', encoding: 'base64', sha: 'a'.repeat(40),
        content: Buffer.from(JSON.stringify(inventory)).toString('base64')
      });
    };
    worker = createWorker({ signingKeys });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const response = await worker.fetch(new Request(`${origin}/api/drawers`, {
    headers: { 'Cf-Access-Jwt-Assertion': validToken }
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).drawers.length, 210);
  assert.equal(calls, 1);
});

test('GitHub redirects are rejected without forwarding credentials to the target', async () => {
  let calls = 0;
  const worker = createWorker({
    signingKeys,
    fetchGitHub: async (url, options) => {
      calls++;
      assert.equal(new URL(url).hostname, 'api.github.com');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'https://other.example' } });
    }
  });
  const response = await worker.fetch(new Request(`${origin}/api/drawers`, {
    headers: { 'Cf-Access-Jwt-Assertion': validToken }
  }), env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 302/);
  assert.equal(calls, 1);
});

test('network failure during loading does not incorrectly imply that a save was attempted', async () => {
  const worker = createWorker({
    signingKeys,
    fetchGitHub: async () => { throw new TypeError('Network unavailable'); }
  });
  const response = await worker.fetch(new Request(`${origin}/api/drawers`, {
    headers: { 'Cf-Access-Jwt-Assertion': validToken }
  }), env);
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.match(result.error, /No save was attempted/);
  assert.doesNotMatch(result.error, /save may have completed/);
});

test('invalid GitHub inventory is not overwritten', async () => {
  let writes = 0;
  const worker = createWorker({
    signingKeys,
    fetchGitHub: async (url, options) => {
      if (options.method === 'PUT') writes++;
      return Response.json({ type: 'file', encoding: 'base64', sha: 'a'.repeat(40), content: btoa('[]') });
    }
  });
  const response = await worker.fetch(new Request(`${origin}/api/drawers/101`, {
    method: 'PATCH',
    headers: { 'Cf-Access-Jwt-Assertion': validToken, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: { title: inventory[100].title }, changes: { title: 'Draft' } })
  }), env);
  assert.equal(response.status, 502);
  assert.equal(writes, 0);
});

test('repeated GitHub SHA conflicts stop after three bounded attempts', async () => {
  let writes = 0;
  const worker = createWorker({
    signingKeys,
    fetchGitHub: async (url, options) => {
      if (options.method === 'PUT') {
        writes++;
        return Response.json({ message: 'race' }, { status: 409 });
      }
      return Response.json({ type: 'file', encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify(inventory)).toString('base64') });
    }
  });
  const response = await worker.fetch(new Request(`${origin}/api/drawers/101`, {
    method: 'PATCH',
    headers: { 'Cf-Access-Jwt-Assertion': validToken, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: { title: inventory[100].title }, changes: { title: 'Draft' } })
  }), env);
  assert.equal(response.status, 409);
  assert.equal(writes, 3);
});

test('unknown API routes return an explicit error after authentication', async () => {
  const f = fixture();
  const response = await f.worker.fetch(new Request(`${origin}/api/unknown`, {
    headers: { 'Cf-Access-Jwt-Assertion': validToken }
  }), env);
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
  assert.equal(f.calls.length, 0);
});

test('static requests use the asset binding without exposing a GitHub credential', async () => {
  const request = new Request(`${origin}/images/MVIMG_20261028_141136.jpg`);
  const expected = new Response('photo');
  const worker = createWorker();
  const result = await worker.fetch(request, {
    ...env, ASSETS: { fetch: async forwarded => {
      assert.equal(forwarded, request);
      assert.equal(forwarded.headers.get('Authorization'), null);
      return expected;
    } }
  });
  assert.equal(result, expected);
});
