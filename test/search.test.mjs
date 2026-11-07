import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawerFilter } from '../html/search.js';

const drawers = Array.from({ length: 210 }, (_, index) => ({
  number: String(index + 1).padStart(3, '0'),
  position: `L${Math.floor(index / 5) + 1}/${index % 5 + 1}`,
  title: 'M3 screws',
  description: 'Stainless steel',
  remark: 'Size 90-96',
  searchTag: ['hardware', 'INOX']
}));
const numbers = query => drawers.filter(createDrawerFilter(query)).map(drawer => drawer.number);

test('drawer range includes both endpoints and matches numbers rather than content', () => {
  const expected = ['090', '091', '092', '093', '094', '095', '096'];
  for (const query of ['90-96', '090-096', ' 90 - 096 ']) {
    assert.deepEqual(numbers(query), expected);
  }
});

test('range handles single drawers, boundaries, and empty or reversed intervals', () => {
  assert.deepEqual(numbers('96-96'), ['096']);
  assert.deepEqual(numbers('0-2'), ['001', '002']);
  assert.deepEqual(numbers('209-999'), ['209', '210']);
  assert.deepEqual(numbers('211-220'), []);
  assert.deepEqual(numbers('96-90'), []);
  assert.equal(numbers('1-210').length, 210);
});

test('ordinary case-insensitive multiword and field searches are unchanged', () => {
  for (const query of ['', '  ', 'SCREWS inox', 'steel hardware', 'Size 90-96']) {
    assert.equal(numbers(query).length, 210);
  }
  assert.deepEqual(numbers('L19/1'), ['091']);
  assert.deepEqual(numbers('096'), ['096']);
  assert.deepEqual(numbers('missing'), []);
  assert.equal(numbers('90-').length, 210);
});
