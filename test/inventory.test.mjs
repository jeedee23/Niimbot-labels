import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access, mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createInventoryStore, validateInventory } from '../lib/inventory.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const inventoryPath = join(root, 'drawers.json');
const htmlPath = join(root, 'html');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'niimbot-test-'));
  const path = join(directory, 'drawers.json');
  await copyFile(inventoryPath, path);
  const app = createApp({ inventoryPath: path, htmlPath });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const url = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    app.close();
    app.closeAllConnections();
    await once(app, 'close');
    await rm(directory, { recursive: true });
  });
  return {
    url, path, directory,
    async get() { return (await (await fetch(`${url}/api/drawers`)).json()).drawers; },
    patch(number, base, changes) {
      return fetch(`${url}/api/drawers/${number}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, changes })
      });
    }
  };
}

test('inventory contains every drawer 001-210 in its exact five-column position', async () => {
  const drawers = validateInventory(JSON.parse(await readFile(inventoryPath, 'utf8')));
  assert.equal(drawers.length, 210);
  assert.equal(drawers[34].position, 'L7/5');
  assert.equal(drawers[35].position, 'L8/1');
  assert.equal(drawers[100].position, 'L21/1');
  assert.equal(drawers[105].position, 'L22/1');
  assert.equal(drawers[209].position, 'L42/5');
  for (const drawer of drawers.slice(0, 35)) {
    assert.equal(drawer.title, 'NON EXIST');
    assert.equal(drawer.description, 'Non exist');
    assert.equal(drawer.remark, 'This drawer will come');
    assert.deepEqual(drawer.searchTag, ['empty']);
    assert.equal(drawer.photo, null);
  }
});

test('all twelve photos are linked, originals retained, with no missing display assets', async () => {
  const drawers = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const photos = (await readdir(join(root, 'photos'))).filter(name => name.endsWith('.jpg')).sort();
  const linked = [...new Set(drawers.map(drawer => drawer.photo).filter(Boolean))].sort();
  assert.deepEqual(linked, photos.map(name => `images/${name}`));
  for (const drawer of drawers.slice(35)) {
    assert.ok(drawer.photo);
    await access(join(htmlPath, drawer.photo));
  }
});

test('approved bottom row, photo anchors and visible missing drawers are preserved', async () => {
  const drawers = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.equal(drawers[100].title, 'M3 afstand');
  assert.equal(drawers[100].description, 'M3 Afstandbussen');
  assert.equal(drawers[100].remark, 'Afstandsbussen verscheidene maten');
  assert.deepEqual(drawers[100].searchTag, ['afstandsbus', 'M3', 'afstand']);
  assert.deepEqual(drawers.slice(100, 105).map(d => d.photo), Array(5).fill('images/MVIMG_20261028_141136.jpg'));
  assert.equal(drawers[90].sourceLabel, 'LED DISPLAY');
  assert.equal(drawers[35].photo, 'images/MVIMG_20261028_141215.jpg');
  assert.equal(drawers[209].photo, 'images/MVIMG_20261028_141233.jpg');
  assert.equal(drawers[105].photo, 'images/MVIMG_20261028_141322.jpg');
  for (const n of [48, 108, 130]) {
    assert.equal(drawers[n - 1].title, 'NON EXIST');
    assert.match(drawers[n - 1].remark, /ontbreekt/);
  }
  for (const drawer of drawers.filter(d => d.title === 'ONBEKEND')) assert.match(drawer.remark, /controleren/);
});

test('API persists exact spaces, newlines and tags to disk', async t => {
  const f = await fixture(t);
  const old = (await f.get())[100];
  const changes = { title: ' M3  afstand ', description: 'line one \n line two  ', remark: ' remark  ', searchTag: [' M3 ', 'afstand  ', ''] };
  const base = Object.fromEntries(Object.keys(changes).map(key => [key, old[key]]));
  const response = await f.patch('101', base, changes);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  for (const key of Object.keys(changes)) assert.deepEqual(result.drawer[key], changes[key]);
  const disk = JSON.parse(await readFile(f.path, 'utf8'));
  for (const key of Object.keys(changes)) assert.deepEqual(disk[100][key], changes[key]);
  assert.equal(disk[100].number, old.number);
  assert.equal(disk[100].position, old.position);
  assert.equal(disk[100].photo, old.photo);
  assert.equal(disk[100].sourceLabel, old.sourceLabel);
  assert.deepEqual(await readdir(f.directory), ['drawers.json']);
  assert.equal((await createInventoryStore(f.path).read())[100].title, changes.title);
});

test('same-field concurrent edits conflict without overwriting saved work', async t => {
  const f = await fixture(t);
  const old = (await f.get())[100];
  const responses = await Promise.all([
    f.patch('101', { title: old.title }, { title: 'First writer' }),
    f.patch('101', { title: old.title }, { title: 'Second writer' })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = await responses.find(response => response.status === 200).json();
  assert.equal((await f.get())[100].title, winner.drawer.title);
  assert.match((await responses.find(response => response.status === 409).json()).error, /retained/);
});

test('different fields and drawers can be saved concurrently without losing changes', async t => {
  const f = await fixture(t);
  const drawers = await f.get();
  const responses = await Promise.all([
    f.patch('101', { title: drawers[100].title }, { title: 'Changed title' }),
    f.patch('101', { remark: drawers[100].remark }, { remark: 'Changed remark' }),
    f.patch('102', { description: drawers[101].description }, { description: 'Changed description' })
  ]);
  assert.ok(responses.every(response => response.status === 200));
  const updated = await f.get();
  assert.equal(updated[100].title, 'Changed title');
  assert.equal(updated[100].remark, 'Changed remark');
  assert.equal(updated[101].description, 'Changed description');
});

test('invalid edits are rejected and do not poison subsequent saves', async t => {
  const f = await fixture(t);
  const old = (await f.get())[100];
  for (const [base, changes] of [
    [{ number: '101' }, { number: '001' }],
    [{ title: old.title }, { title: null }],
    [{ searchTag: old.searchTag }, { searchTag: 'not an array' }],
    [{}, { title: 'missing base' }],
    [{ title: old.title, remark: old.remark }, { title: 'extra base' }],
    [{}, {}],
    [{ title: old.title }, { title: 'x'.repeat(20001) }]
  ]) {
    const response = await f.patch('101', base, changes);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal((await f.patch('999', { title: '' }, { title: 'unknown' })).status, 404);
  assert.equal((await f.patch('101', { title: old.title }, { title: 'Valid after errors' })).status, 200);
});

test('JSON and media-type errors are explicit', async t => {
  const f = await fixture(t);
  const malformed = await fetch(`${f.url}/api/drawers/101`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /Invalid JSON/);
  const wrongType = await fetch(`${f.url}/api/drawers/101`, { method: 'PATCH', body: '{}' });
  assert.equal(wrongType.status, 415);
  const tooLarge = await fetch(`${f.url}/api/drawers/101`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(530000) })
  });
  assert.equal(tooLarge.status, 413);
  assert.match((await tooLarge.json()).error, /too large/);
});

test('localhost API rejects foreign hosts and origins', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Host: 'evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' }
  ]) {
    const response = await new Promise((resolve, reject) => {
      const req = request(`${f.url}/api/drawers`, { headers }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.ok(JSON.parse(response.body).error);
  }
  const allowed = await fetch(`${f.url}/api/drawers`, { headers: { Origin: f.url } });
  assert.equal(allowed.status, 200);
});

test('static files and photos are served but repository files are not exposed', async t => {
  const f = await fixture(t);
  for (const [path, type] of [
    ['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'],
    ['/images/MVIMG_20261028_141136.jpg', 'image/jpeg']
  ]) {
    const response = await fetch(`${f.url}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  for (const path of ['/drawers.json', '/server.mjs', '/.git/config', '/images/../../server.mjs', '/images/missing.jpg']) {
    assert.equal((await fetch(`${f.url}${path}`)).status, 404);
  }
  const head = await fetch(`${f.url}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${f.url}/`, { method: 'POST' })).status, 405);
});

test('invalid on-disk inventory is rejected rather than replaced with a default', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '[]\n');
  await assert.rejects(createInventoryStore(f.path).read(), /exactly 210/);
  assert.equal(await readFile(f.path, 'utf8'), '[]\n');
});
