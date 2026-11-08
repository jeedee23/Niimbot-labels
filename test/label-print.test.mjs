import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { printGeometry, renderLabelCanvas, validatePrintSelection, waitForPrintCompletion, printSelectedLabels } from '../html/label-print.js';

const drawer = { number: '101', position: 'L21/1', title: 'M3 afstand', description: 'M3 Afstandbussen' };
const metadata = { model: 'M2_H', dpi: 300, printheadPixels: 567 };
const connectedClient = () => ({ isConnected: () => true, getModelMetadata: () => metadata });

function canvasFixture() {
  const calls = [];
  const pixels = new Uint8ClampedArray([0, 0, 0, 0, 127, 127, 127, 255, 128, 128, 128, 0, 255, 255, 255, 255]);
  const context = {
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    save() {}, restore() {}, beginPath() {}, clip() {},
    translate: (...args) => calls.push(['translate', ...args]),
    scale: (...args) => calls.push(['scale', ...args]),
    rect: (...args) => calls.push(['rect', ...args]),
    strokeRect: (...args) => calls.push(['strokeRect', ...args]),
    fillText: (...args) => calls.push(['text', ...args]),
    getImageData: () => ({ data: pixels }),
    putImageData: () => {}
  };
  return { canvas: { getContext: () => context }, calls, pixels };
}

test('print raster fits the head, is byte-aligned, and crops only within the white margins', () => {
  assert.deepEqual(printGeometry, { dpi: 300, headPixels: 567, width: 560, height: 354 });
  assert.equal(printGeometry.width % 8, 0);
  assert.ok(printGeometry.width <= printGeometry.headPixels);
  const croppedMm = (50 - printGeometry.width * 25.4 / 300) / 2;
  assert.ok(croppedMm < 1.5);
  assert.ok(Math.abs(printGeometry.height * 25.4 / 300 - 30) < 0.05);
  const fixture = canvasFixture();
  renderLabelCanvas(drawer, fixture.canvas);
  assert.equal(fixture.canvas.width, 560);
  assert.equal(fixture.canvas.height, 354);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'rect'), ['rect', 1.5, 1.5, 47, 27]);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'strokeRect'), ['strokeRect', 2, 2, 46, 9]);
  assert.ok(fixture.calls.some(call => call[0] === 'text' && call[1] === 'M3 afstand'));
  assert.ok(fixture.calls.some(call => call[0] === 'text' && call[1] === 'M3 AFSTANDBUSSEN'));
  assert.deepEqual([...fixture.pixels], [0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
});

test('printing rejects empty selection, disconnected devices, wrong models and invalid labels before sending', async () => {
  assert.throws(() => validatePrintSelection(connectedClient(), []), /Select at least/);
  assert.throws(() => validatePrintSelection(null, [drawer]), /Connect the USB/);
  for (const wrong of [{}, { ...metadata, model: 'B1' }, { ...metadata, dpi: 203 }, { ...metadata, printheadPixels: 640 }]) {
    assert.throws(() => validatePrintSelection({ ...connectedClient(), getModelMetadata: () => wrong }, [drawer]), /only the M2-H/);
  }
  assert.throws(() => validatePrintSelection(connectedClient(), [{ ...drawer, number: null }]), /valid drawer/);
  await assert.rejects(printSelectedLabels(null, [drawer]), /Connect the USB/);
});

test('completion waits for both printing and feed, without overlapping polls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statuses = [
    { page: 2, pagePrintProgress: 100, pageFeedProgress: 50 },
    { page: 2, pagePrintProgress: 100, pageFeedProgress: 100 }
  ];
  const reports = [];
  let polls = 0;
  const client = { ...connectedClient(), protocol: { async getPrintStatus() { polls++; return statuses.shift(); } } };
  const completion = waitForPrintCompletion(client, 2, message => reports.push(message));
  await Promise.resolve();
  assert.equal(polls, 1);
  t.mock.timers.tick(300);
  await completion;
  assert.equal(polls, 2);
  assert.equal(reports.length, 2);
});

test('completion has a bounded deadline and propagates disconnect/status errors', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const client = { ...connectedClient(), protocol: { async getPrintStatus() { return { page: 0, pagePrintProgress: 0, pageFeedProgress: 0 }; } } };
  const completion = waitForPrintCompletion(client, 1, () => {});
  const rejection = assert.rejects(completion, /Timed out/);
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  await rejection;
  await assert.rejects(waitForPrintCompletion({ isConnected: () => false }, 1, () => {}), /disconnected/);
  client.protocol.getPrintStatus = async () => { throw new Error('Paper missing'); };
  await assert.rejects(waitForPrintCompletion(client, 1, () => {}), /Paper missing/);
});

function browserStubs(t) {
  for (const [name, value] of Object.entries({
    FontFace: class { async load() { return this; } },
    document: {
      fonts: { add() {} },
      createElement() {
        const fixture = canvasFixture();
        const context = fixture.canvas.getContext();
        context.getImageData = () => ({
          data: new Uint8ClampedArray(fixture.canvas.width * fixture.canvas.height * 4).fill(255)
        });
        return fixture.canvas;
      }
    }
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
}

test('selected labels print once in supplied order with the M2-H task, and end only after completion', async t => {
  browserStubs(t);
  const calls = [];
  const task = {
    async printInit() { calls.push('init'); },
    async printPage(image, quantity) {
      assert.equal(image.cols, 560);
      assert.equal(image.rows, 354);
      assert.equal(quantity, 1);
      calls.push('page');
    },
    async waitForPageFinished() {},
    async printEnd() { calls.push('end'); return true; }
  };
  const client = {
    ...connectedClient(),
    protocol: {
      newPrintTask(name, options) {
        assert.equal(name, 'B1');
        assert.equal(options.totalPages, 2);
        assert.equal(options.density, 3);
        calls.push('task');
        return task;
      },
      async getPrintStatus() {
        calls.push('completed');
        return { page: 2, pagePrintProgress: 100, pageFeedProgress: 100 };
      }
    }
  };
  const reports = [];
  await printSelectedLabels(client, [drawer, { ...drawer, number: '105' }], message => reports.push(message));
  assert.deepEqual(calls, ['task', 'init', 'page', 'page', 'completed', 'end']);
  assert.ok(reports.some(message => /drawer 101: label 1\/2/.test(message)));
  assert.ok(reports.some(message => /drawer 105: label 2\/2/.test(message)));
});

test('failed transmission is not retried and print-end failures are surfaced alongside the original error', async t => {
  browserStubs(t);
  let pages = 0;
  let endings = 0;
  const client = {
    ...connectedClient(),
    protocol: {
      newPrintTask() {
        return {
          async printInit() {},
          async printPage() { pages++; throw new Error('Paper missing'); },
          async printEnd() { endings++; return false; }
        };
      }
    }
  };
  await assert.rejects(printSelectedLabels(client, [drawer]), /Paper missing.*did not acknowledge print end/);
  assert.equal(pages, 1);
  assert.equal(endings, 1);
});

test('local and Cloudflare builds serve a locally bundled print module', async () => {
  const root = new URL('..', import.meta.url);
  const [server, headers, manifest, html] = await Promise.all([
    readFile(new URL('server.mjs', root), 'utf8'),
    readFile(new URL('html/_headers', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('html/index.html', root), 'utf8')
  ]);
  assert.match(server, /\/label-print\.bundle\.js/);
  assert.match(headers, /script-src 'self'/);
  assert.match(JSON.parse(manifest).scripts['build:labels'], /label-print\.bundle\.js/);
  for (const id of ['connect-printer', 'print-labels', 'disconnect-printer', 'printer-status']) assert.match(html, new RegExp(`id="${id}"`));
});
