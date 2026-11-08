import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { validateInventory, applyPhoto } from '../lib/inventory-schema.mjs';
import { validatePhotoUpload, maximumPhotoBytes } from '../lib/photo-upload.mjs';
import { resizedDimensions } from '../html/photo-upload.js';
import { createInventoryStore } from '../lib/inventory.mjs';
import { unusedPhoto } from '../lib/inventory-schema.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';

test('cleanup excludes dummy, originals and invalid paths', () => {
  for (const path of [null, 'images/dummy.jpg', 'photos/MVIMG_20000101_010101.jpg', '../secret']) {
    assert.equal(unusedPhoto([], path), false);
  }
});

test('queued local cleanup deletes a grouped photo only after the last reference and reports failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drawer-cleanup-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'drawers.json');
  const drawers = JSON.parse(await readFile(new URL('../drawers.json', import.meta.url), 'utf8'));
  const old = 'images/MVIMG_20000101_010101.jpg';
  drawers[0].photo = old;
  drawers[1].photo = old;
  await writeFile(path, JSON.stringify(drawers));
  const store = createInventoryStore(path);
  const removed = [];
  const remove = async photo => {
    assert.ok(!(await store.read()).some(drawer => drawer.photo === photo));
    removed.push(photo);
  };
  const first = `images/drawer_001_${'a'.repeat(32)}.png`;
  const second = `images/drawer_002_${'b'.repeat(32)}.png`;
  await store.setPhoto('001', old, first, remove);
  assert.deepEqual(removed, []);
  await store.setPhoto('002', old, second, remove);
  assert.deepEqual(removed, [old]);
  const result = await store.setPhoto('001', first, `images/drawer_001_${'c'.repeat(32)}.png`,
    async () => { throw new Error('cleanup unavailable'); });
  assert.match(result.warning, /new image is saved/);
  assert.equal((await store.read())[0].photo, result.drawer.photo);
});

test('portrait resizing preserves aspect ratio without upscaling', () => {
  assert.deepEqual(resizedDimensions(2304, 4096), { width: 900, height: 1600 });
  assert.deepEqual(resizedDimensions(768, 1365), { width: 768, height: 1365 });
  assert.deepEqual(resizedDimensions(4096, 2304), { width: 1600, height: 900 });
  assert.throws(() => resizedDimensions(0, 1), /invalid dimensions/);
});

test('validates PNG/JPEG content, bounded payloads and original photo paths', () => {
  const payload = { basePhoto: null, type: 'image/png', content: png };
  assert.equal(validatePhotoUpload(payload).extension, 'png');
  for (const invalid of [
    { ...payload, type: 'image/svg+xml' }, { ...payload, content: '' },
    { ...payload, content: 'not base64' }, { ...payload, content: btoa('<script>bad</script>') },
    { ...payload, basePhoto: '../secret' }, { ...payload, other: true },
    { ...payload, content: 'A'.repeat(Math.ceil(maximumPhotoBytes / 3) * 4 + 4) }
  ]) assert.throws(() => validatePhotoUpload(invalid));
});

test('drawer-photo changes preserve every unrelated field and reject cross-drawer references', async () => {
  const drawers = JSON.parse(await readFile(new URL('../drawers.json', import.meta.url), 'utf8'));
  const before = structuredClone(drawers);
  const photo = `images/drawer_101_${'a'.repeat(32)}.png`;
  applyPhoto(drawers, '101', drawers[100].photo, photo);
  assert.doesNotThrow(() => validateInventory(drawers));
  for (let index = 0; index < drawers.length; index++) {
    assert.deepEqual(drawers[index], index === 100 ? { ...before[index], photo } : before[index]);
  }
  assert.throws(() => applyPhoto(drawers, '101', before[100].photo, photo), /changed elsewhere/);
  assert.throws(() => applyPhoto(drawers, '102', drawers[101].photo, photo), /belong to this drawer/);
});

test('local upload persists a unique image, changes only one drawer, serves it, and cleans up on a conflict', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drawer-photo-test-'));
  const inventoryPath = join(directory, 'drawers.json');
  const htmlPath = join(directory, 'html');
  await mkdir(join(htmlPath, 'images'), { recursive: true });
  await copyFile(new URL('../drawers.json', import.meta.url), inventoryPath);
  const before = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const old = 'images/MVIMG_20000101_010101.jpg';
  before[100].photo = old;
  before[101].photo = old;
  await writeFile(inventoryPath, JSON.stringify(before));
  await writeFile(join(htmlPath, old), Buffer.from(png, 'base64'));
  const app = createApp({ inventoryPath, htmlPath });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    app.close();
    app.closeAllConnections();
    await once(app, 'close');
    await rm(directory, { recursive: true });
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  const upload = () => fetch(`${url}/api/drawers/101/photo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ basePhoto: before[100].photo, type: 'image/png', content: png })
  });
  const response = await upload();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.drawer.photo, /^images\/drawer_101_[a-f0-9]{32}\.png$/);
  const disk = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.deepEqual(disk, before.map(drawer => drawer.number === '101' ? { ...drawer, photo: result.drawer.photo } : drawer));
  const imageResponse = await fetch(`${url}/api/photos/${result.drawer.photo.slice(7)}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('Content-Type'), 'image/png');
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString('base64'), png);
  assert.ok((await readdir(join(htmlPath, 'images'))).includes(old.slice(7)));
  assert.equal((await upload()).status, 409);
  const lastReplacement = await fetch(`${url}/api/drawers/102/photo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ basePhoto: old, type: 'image/png', content: png })
  });
  assert.equal(lastReplacement.status, 200);
  const last = await lastReplacement.json();
  assert.deepEqual((await readdir(join(htmlPath, 'images'))).sort(),
    [result.drawer.photo.slice(7), last.drawer.photo.slice(7)].sort());
});
