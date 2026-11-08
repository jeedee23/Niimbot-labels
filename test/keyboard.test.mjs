import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyKey, keyboardRows, keyValue } from '../html/keyboard.js';

test('three keyboard rows occupy 20 tracks, with the approved four-column numpad', () => {
  assert.equal(keyboardRows.length, 3);
  for (const row of keyboardRows) assert.equal(row.reduce((total, key) => total + (key.span || 1), 0), 20);
  assert.deepEqual(keyboardRows.map(row => row.filter(key => key.number).map(key => key.value)), [
    ['-', '7', '8', '9'], ['.', '4', '5', '6'], ['0', '1', '2', '3']
  ]);
  assert.equal(keyboardRows[0].slice(0, 10).map(key => key.value).join(''), 'azertyuiop');
  assert.equal(keyboardRows[1].slice(1, 11).map(key => key.value).join(''), 'qsdfghjklm');
  assert.equal(keyboardRows[2].slice(1, 7).map(key => key.value).join(''), 'wxcvbn');
});

test('Shift and Caps produce uppercase letters without shifting the numeric keypad', () => {
  const a = keyboardRows[0][0];
  assert.equal(keyValue(a), 'a');
  assert.equal(keyValue(a, { shift: true }), 'A');
  assert.equal(keyValue(a, { caps: true }), 'A');
  assert.equal(keyValue(a, { shift: true, caps: true }), 'a');
  for (const key of keyboardRows[2].filter(key => key.number)) {
    assert.equal(keyValue(key, { shift: true, caps: true }), key.value);
  }
  assert.equal(keyValue({ value: ',', shifted: '?' }, { shift: true }), '?');
});

test('typing replaces a selection and preserves surrounding whitespace and newlines', () => {
  assert.deepEqual(applyKey(' abc  ', 2, 4, 'XY'), { value: ' aXY  ', cursor: 4 });
  assert.deepEqual(applyKey('a\nb', 1, 1, ' '), { value: 'a \nb', cursor: 2 });
  assert.deepEqual(applyKey('abc', 3, 3, '\n'), { value: 'abc\n', cursor: 4 });
});

test('Backspace removes selections and complete Unicode graphemes, never half a surrogate pair', () => {
  assert.deepEqual(applyKey('abc', 1, 3, 'Backspace'), { value: 'a', cursor: 1 });
  assert.deepEqual(applyKey('abc', 0, 0, 'Backspace'), { value: 'abc', cursor: 0 });
  for (const grapheme of ['\u{1F527}', 'e\u0301', '\u{1F469}\u200D\u{1F527}']) {
    assert.deepEqual(applyKey(`a${grapheme}b`, 1 + grapheme.length, 1 + grapheme.length, 'Backspace'), { value: 'ab', cursor: 1 });
  }
  assert.deepEqual(applyKey('a\u{1F527}b', 2, 2, 'Backspace'), { value: 'ab', cursor: 1 });
});

test('keyboard reports invalid cursor positions and field limits rather than silently dropping text', () => {
  assert.throws(() => applyKey('abc', -1, 0, 'x'), /cursor/);
  assert.throws(() => applyKey('abc', 2, 1, 'x'), /cursor/);
  assert.throws(() => applyKey('abc', 0, 4, 'x'), /cursor/);
  assert.throws(() => applyKey('abc', 3, 3, 'x', 3), /at most 3/);
  assert.deepEqual(applyKey('abc', 2, 3, 'x', 3), { value: 'abx', cursor: 3 });
});

test('touch layout retains 70/30 viewport split, 65/35 columns, fullscreen and one-record editor without a PIN', async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL('../html/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../html/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../html/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(css, /grid-template-rows: 70% 30%/);
  assert.match(css, /grid-template-columns: 65% 35%/);
  assert.match(css, /height: 100dvh/);
  assert.doesNotMatch(html, /<h1|editing-pin|enable-editing/);
  assert.doesNotMatch(app, /sessionStorage|editingUnlocked|editingPin/);
  assert.match(app, /selectedNumbers\.size !== 1/);
  assert.match(app, /requestFullscreen/);
  assert.match(app, /fullscreenchange/);
  assert.match(html, /inputmode="none"/);
});
