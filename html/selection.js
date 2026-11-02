export function selectNumbers(current, visible, number, anchor, { shiftKey = false, ctrlKey = false, metaKey = false, toggle = false } = {}) {
  const additive = ctrlKey || metaKey;
  const selected = new Set(current);
  if (shiftKey && visible.includes(anchor) && visible.includes(number)) {
    if (!additive) selected.clear();
    const start = visible.indexOf(anchor);
    const end = visible.indexOf(number);
    for (const value of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(value);
  } else if (additive || toggle) {
    if (selected.has(number)) selected.delete(number);
    else selected.add(number);
  } else {
    selected.clear();
    selected.add(number);
  }
  return { selected, anchor: shiftKey && visible.includes(anchor) ? anchor : number };
}
