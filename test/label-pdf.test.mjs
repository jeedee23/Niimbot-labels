import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createLabelsPdf } from '../html/label-pdf.js';
import { labelContent } from '../html/label.js';

const fonts = await Promise.all(['Regular', 'Bold'].map(weight =>
  readFile(new URL(`../html/fonts/NotoSansMono-${weight}.ttf`, import.meta.url))));
const drawer = { number: '101', position: 'L21/1', title: 'M3 afstand', description: 'M3 Afstandbussen' };

test('PDF contains one exact 50 x 30 mm page per record with Noto fonts embedded', async () => {
  const bytes = await createLabelsPdf([drawer, { ...drawer, number: '102' }, { ...drawer, number: '103' }], fonts);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 3);
  for (const page of document.getPages()) {
    assert.ok(Math.abs(page.getWidth() - 50 * 72 / 25.4) < 0.00001);
    assert.ok(Math.abs(page.getHeight() - 30 * 72 / 25.4) < 0.00001);
  }
  const objects = document.context.enumerateIndirectObjects().map(([, object]) => object.toString()).join('\n');
  assert.match(objects, /NotoSansMono-Regular/);
  assert.match(objects, /NotoSansMono-Bold/);
  assert.match(objects, /FontFile2/);
  assert.doesNotMatch(objects, /LiberationMono|Helvetica|CJK/);
});

test('approved title wrapping and uppercase description match the SVG layout', () => {
  assert.deepEqual(labelContent({ ...drawer, title: 'NOZZLES 0.6 0.8 1.0' }).title, ['NOZZLES 0.6 0.8', '1.0']);
  assert.deepEqual(labelContent(drawer).description, ['M3 AFSTANDBUSSEN']);
  assert.equal(labelContent({ ...drawer, description: 'x'.repeat(200) }).description[1].length, 27);
  assert.match(labelContent({ ...drawer, description: 'x'.repeat(200) }).description[1], /\.\.\.$/);
});

test('empty selections, invalid records and missing glyphs report explicit errors', async () => {
  await assert.rejects(createLabelsPdf([], fonts), /Select at least one/);
  await assert.rejects(createLabelsPdf([{ ...drawer, number: 'x' }], fonts), /valid drawer/);
  await assert.rejects(createLabelsPdf([{ ...drawer, title: '\u{1F527}' }], fonts), /does not support/);
});

test('font download failures reject PDF creation instead of returning a broken download', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    await assert.rejects(createLabelsPdf([drawer]), /Could not load NotoSansMono-.*HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
