const letter = value => ({ value, label: value });
const action = (name, label, span = 1) => ({ action: name, label, span });
const punctuation = (value, shifted) => ({ value, shifted, label: value });
const numbers = values => values.map(value => ({ value, label: value, number: true }));

export const keyboardRows = [
  [...'azertyuiop'].map(letter).concat([
    action('symbols', '#+='),
    punctuation('$', '*'),
    action('backspace', 'Backspace', 3),
    { gap: true },
    ...numbers(['-', '7', '8', '9'])
  ]),
  [
    action('caps', 'Caps Lock', 2),
    ...[...'qsdfghjklm'].map(letter),
    punctuation('ù', '%'),
    action('enter', 'Enter', 2),
    { gap: true },
    ...numbers(['.', '4', '5', '6'])
  ],
  [
    action('shift', 'Shift', 2),
    ...[...'wxcvbn'].map(letter),
    punctuation(',', '?'), punctuation(';', '.'), punctuation(':', '/'), punctuation('!', '§'),
    action('space', 'Space', 3),
    { gap: true },
    ...numbers(['0', '1', '2', '3'])
  ]
];

const symbolValues = [...'éèêëàâäôöûüç', '-', "'", '"', '(', ')', '[', ']', '/', '\\', '@', '#', '&', '+', '=', '^', '€', '_'];

export function keyValue(key, { shift = false, caps = false } = {}) {
  if (key.number) return key.value;
  if (shift && key.shifted) return key.shifted;
  return shift !== caps ? key.value.toLocaleUpperCase('fr-BE') : key.value;
}

function boundaries(value) {
  return [...new Intl.Segmenter('fr-BE', { granularity: 'grapheme' }).segment(value)].map(part => part.index).concat(value.length);
}

export function applyKey(value, start, end, key, maximumLength = -1) {
  if (start < 0 || end < start || end > value.length) throw new Error('The text cursor is outside the input.');
  let insertion = key;
  if (key === 'Backspace') {
    insertion = '';
    if (start === end && start > 0) {
      const positions = boundaries(value);
      const previous = positions.filter(position => position < start).at(-1);
      const next = positions.find(position => position >= start);
      start = previous;
      end = next;
    }
  }
  const result = value.slice(0, start) + insertion + value.slice(end);
  if (maximumLength >= 0 && result.length > maximumLength) throw new Error(`This field allows at most ${maximumLength} characters.`);
  return { value: result, cursor: start + insertion.length };
}

export function createKeyboard(container, { onSearch, onError }) {
  let target = null;
  let selection = null;
  let shift = false;
  let caps = false;
  let symbols = false;

  const remember = () => {
    if (target && document.activeElement === target) {
      selection = { start: target.selectionStart, end: target.selectionEnd };
    }
  };

  function focusTarget(input) {
    target = input;
    input.focus({ preventScroll: true });
    selection = { start: input.selectionStart, end: input.selectionEnd };
  }

  function clearTarget() {
    target = null;
    selection = null;
  }

  document.addEventListener('focusin', event => {
    if ((event.target instanceof HTMLInputElement && event.target.type === 'search') ||
        event.target instanceof HTMLTextAreaElement) {
      target = event.target;
      selection = { start: target.selectionStart, end: target.selectionEnd };
    }
  });
  document.addEventListener('selectionchange', remember);
  document.addEventListener('keyup', remember);
  document.addEventListener('pointerup', remember);

  function press(key) {
    if (key.action === 'shift') { shift = !shift; draw(); return; }
    if (key.action === 'caps') { caps = !caps; draw(); return; }
    if (key.action === 'symbols') { symbols = !symbols; draw(); return; }
    if (!target?.isConnected || target.disabled || target.readOnly || !selection) {
      onError('Tap Search or an editable field before using the keyboard.');
      return;
    }
    if (key.action === 'enter' && target instanceof HTMLInputElement) {
      const input = target;
      onSearch();
      focusTarget(input);
      return;
    }
    const value = key.action === 'backspace' ? 'Backspace' : key.action === 'enter' ? '\n' :
      key.action === 'space' ? ' ' : keyValue(key, { shift, caps });
    try {
      const result = applyKey(target.value, selection.start, selection.end, value, target.maxLength);
      target.value = result.value;
      target.focus({ preventScroll: true });
      target.setSelectionRange(result.cursor, result.cursor);
      selection = { start: result.cursor, end: result.cursor };
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (shift && !key.action && !key.number) { shift = false; draw(); }
    } catch (error) {
      onError(error.message);
    }
  }

  function draw() {
    container.replaceChildren();
    let symbolIndex = 0;
    for (const keys of keyboardRows) {
      const row = document.createElement('div');
      row.className = 'keyboard-row';
      for (const original of keys) {
        const key = symbols && !original.gap && !original.action && !original.number ?
          { ...original, value: symbolValues[symbolIndex++] || original.value, shifted: undefined } : original;
        if (key.gap) { row.append(document.createElement('span')); continue; }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `keyboard-key${key.action ? ' function' : ''}${key.number ? ' number' : ''}${key.action === 'caps' ? ' caps' : ''}`;
        if (key.span) button.style.gridColumn = `span ${key.span}`;
        const label = key.action === 'symbols' ? (symbols ? 'ABC' : '#+=') :
          key.action ? key.label : keyValue(key, { shift, caps });
        button.textContent = label;
        button.dataset.key = key.action || key.value;
        if (['caps', 'shift', 'symbols'].includes(key.action)) {
          const active = key.action === 'caps' ? caps : key.action === 'shift' ? shift : symbols;
          button.setAttribute('aria-pressed', String(active));
        }
        if (key.action === 'shift' || key.action === 'caps') {
          const note = document.createElement('small');
          note.textContent = key.action === 'shift' ? 'next letter' : caps ? 'ON' : 'OFF';
          button.append(note);
        }
        button.addEventListener('pointerdown', event => {
          remember();
          event.preventDefault();
        });
        button.addEventListener('click', () => press(key));
        row.append(button);
      }
      container.append(row);
    }
  }

  draw();
  return { focusTarget, clearTarget };
}
