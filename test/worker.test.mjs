import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';

test('hosted preview returns all drawers and explicitly declares read-only mode', async () => {
  const response = await worker.fetch(new Request('https://niimbot-labels.example/api/drawers'), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.readOnly, true);
  assert.equal(result.drawers.length, 210);
  assert.equal(result.drawers[100].number, '101');
});

test('hosted saving never reports success until GitHub persistence is configured', async () => {
  const response = await worker.fetch(new Request('https://niimbot-labels.example/api/drawers/101', {
    method: 'PATCH', body: JSON.stringify({ changes: { title: 'Do not save' } })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /read-only/);
  const result = await (await worker.fetch(new Request('https://niimbot-labels.example/api/drawers'), {})).json();
  assert.notEqual(result.drawers[100].title, 'Do not save');
});

test('unknown API requests do not fall through to static HTML', async () => {
  const response = await worker.fetch(new Request('https://niimbot-labels.example/api/unknown'), {});
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});

test('non-API requests use the Cloudflare asset binding', async () => {
  const request = new Request('https://niimbot-labels.example/images/MVIMG_20261028_141136.jpg');
  const expected = new Response('photo');
  const result = await worker.fetch(request, {
    ASSETS: { fetch: async forwarded => {
      assert.equal(forwarded, request);
      return expected;
    } }
  });
  assert.equal(result, expected);
});
