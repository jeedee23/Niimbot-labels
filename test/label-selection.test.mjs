import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabelSvg, labelSize } from '../html/label.js';
import { selectNumbers } from '../html/selection.js';

const visible = ['001', '002', '003', '004', '005'];
const drawer = { number: '101', position: 'L21/1', title: 'M3 afstand', description: 'M3 Afstandbussen' };

test('plain row selection replaces existing selection', () => {
  const result = selectNumbers(new Set(['001', '002']), visible, '003', '001');
  assert.deepEqual([...result.selected], ['003']);
  assert.equal(result.anchor, '003');
});

test('Ctrl/Cmd toggles a drawer without dropping other selections', () => {
  const first = selectNumbers(new Set(['001']), visible, '003', '001', { ctrlKey: true });
  assert.deepEqual([...first.selected], ['001', '003']);
  const next = selectNumbers(first.selected, visible, '001', first.anchor, { metaKey: true });
  assert.deepEqual([...next.selected], ['003']);
});

test('checkbox toggles independently without requiring a modifier', () => {
  const result = selectNumbers(new Set(['001']), visible, '005', '001', { toggle: true });
  assert.deepEqual([...result.selected], ['001', '005']);
});

test('Shift selects an inclusive range and keeps its anchor for extension', () => {
  const result = selectNumbers(new Set(['001']), visible, '004', '002', { shiftKey: true });
  assert.deepEqual([...result.selected], ['002', '003', '004']);
  assert.equal(result.anchor, '002');
  const reverse = selectNumbers(result.selected, visible, '001', result.anchor, { shiftKey: true });
  assert.deepEqual([...reverse.selected], ['001', '002']);
});

test('Ctrl+Shift adds a range and does not mutate the old selection', () => {
  const previous = new Set(['005']);
  const result = selectNumbers(previous, visible, '003', '001', { shiftKey: true, ctrlKey: true });
  assert.deepEqual([...result.selected], ['005', '001', '002', '003']);
  assert.deepEqual([...previous], ['005']);
});

test('Shift ranges use only filtered visible drawers; hidden anchors fall back to one row', () => {
  const result = selectNumbers(new Set(['001']), ['001', '003', '005'], '005', '001', { shiftKey: true });
  assert.deepEqual([...result.selected], ['001', '003', '005']);
  const hiddenAnchor = selectNumbers(result.selected, ['003', '005'], '003', '001', { shiftKey: true });
  assert.deepEqual([...hiddenAnchor.selected], ['003']);
  assert.equal(hiddenAnchor.anchor, '003');
});

test('SVG has exact physical dimensions, margin clipping and editable text IDs', () => {
  const svg = createLabelSvg(drawer);
  assert.deepEqual(labelSize, { width: 50, height: 30, margin: 1.5 });
  assert.match(svg, /width="50mm" height="30mm" viewBox="0 0 50 30"/);
  assert.match(svg, /<rect x="1.5" y="1.5" width="47" height="27"\/>/);
  for (const id of ['drawer-number', 'drawer-position', 'drawer-title', 'drawer-description']) {
    assert.match(svg, new RegExp(`<text id="${id}"`));
  }
  assert.match(svg, />101<\/text>/);
  assert.match(svg, />L21\/1<\/text>/);
  assert.match(svg, />M3 afstand<\/tspan>/);
  assert.match(svg, />M3 Afstandbussen<\/tspan>/);
  assert.doesNotMatch(svg, /<image|<script|foreignObject/);
});

test('SVG escapes arbitrary label text instead of interpreting markup', () => {
  const svg = createLabelSvg({ ...drawer, title: '<script> & "test"', description: "A < B & C > D's" });
  assert.match(svg, /&lt;script&gt; &amp; &quot;test&quot;/);
  assert.match(svg, /A &lt; B &amp; C &gt; D&apos;s/);
  assert.doesNotMatch(svg, /<script>/);
});

test('long words wrap and overflowing text is explicitly truncated to fit the label', () => {
  const svg = createLabelSvg({ ...drawer, title: 'A'.repeat(200), description: 'Long description '.repeat(30) });
  const title = /<text id="drawer-title"[^>]*>([\s\S]*?)<\/text>/.exec(svg)[1];
  const description = /<text id="drawer-description"[^>]*>([\s\S]*?)<\/text>/.exec(svg)[1];
  assert.equal((title.match(/<tspan/g) || []).length, 2);
  assert.equal((description.match(/<tspan/g) || []).length, 3);
  assert.match(title, /\.\.\.<\/tspan>/);
  assert.match(description, /\.\.\.<\/tspan>/);
});

test('invalid drawer fields and XML control characters produce explicit errors', () => {
  for (const invalid of [undefined, { ...drawer, number: 101 }, { ...drawer, position: 'other' }, { ...drawer, title: null }]) {
    assert.throws(() => createLabelSvg(invalid), /valid drawer/);
  }
  assert.throws(() => createLabelSvg({ ...drawer, description: 'invalid\u0001text' }), /SVG cannot represent/);
  assert.doesNotThrow(() => createLabelSvg({ ...drawer, title: 'M3 afstand \u{1F527}' }));
});
