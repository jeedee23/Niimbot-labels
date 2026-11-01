const fields = ['title', 'description', 'searchTag', 'remark'];
const delay = 5000;
const elements = Object.fromEntries([
  'drawers', 'search', 'count', 'status', 'save', 'reload', 'export', 'empty',
  'selected', 'source-label', 'photo', 'photo-link', 'photo-message', 'photo-name'
].map(id => [id, document.getElementById(id)]));
const rows = new Map();
const pending = new Map();
const timers = new Map();
const inFlight = new Set();
const failures = new Map();
let drawers = [];
let selectedNumber = null;

function clone(value) {
  return Array.isArray(value) ? [...value] : value;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function status(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function updateStatus() {
  elements.save.disabled = pending.size === 0 || inFlight.size > 0;
  elements.reload.disabled = inFlight.size > 0;
  for (const [number, row] of rows) {
    row.element.classList.toggle('dirty', pending.has(number));
    row.element.classList.toggle('failed', failures.has(number));
    row.status.textContent = failures.has(number) ? 'Save failed' : inFlight.has(number) ? 'Saving...' : pending.has(number) ? 'Unsaved' : '';
  }
  if (failures.size) {
    const [number, message] = failures.entries().next().value;
    status(`${number}: ${message} Unsaved edits remain available in Export JSON.`, true);
  } else if (inFlight.size) {
    status(`Saving ${inFlight.size} drawer(s)...`);
  } else if (pending.size) {
    status(`${pending.size} drawer(s) have unsaved changes. Saving after 5 seconds of inactivity.`);
  } else {
    status('All changes saved.');
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function schedule(number) {
  clearTimeout(timers.get(number));
  timers.set(number, setTimeout(() => {
    timers.delete(number);
    void saveDrawer(number);
  }, delay));
}

function edit(drawer, field, value) {
  const changes = pending.get(drawer.number) || new Map();
  const existing = changes.get(field);
  const base = existing ? existing.base : clone(drawer[field]);
  drawer[field] = clone(value);
  // A value reverted during a save still needs a follow-up write against that save's result.
  if (same(base, value) && !inFlight.has(drawer.number)) {
    changes.delete(field);
  } else {
    changes.set(field, { base, value: clone(value) });
  }
  if (changes.size) {
    pending.set(drawer.number, changes);
    schedule(drawer.number);
  } else {
    pending.delete(drawer.number);
    clearTimeout(timers.get(drawer.number));
    timers.delete(drawer.number);
  }
  failures.delete(drawer.number);
  if (selectedNumber === drawer.number) elements.selected.textContent = `${drawer.number} · ${drawer.position} · ${drawer.title}`;
  updateStatus();
}

async function saveDrawer(number) {
  if (inFlight.has(number) || !pending.has(number)) return;
  clearTimeout(timers.get(number));
  timers.delete(number);
  const snapshot = new Map([...pending.get(number)].map(([field, change]) => [
    field, { base: clone(change.base), value: clone(change.value) }
  ]));
  const base = Object.fromEntries([...snapshot].map(([field, change]) => [field, change.base]));
  const changes = Object.fromEntries([...snapshot].map(([field, change]) => [field, change.value]));
  inFlight.add(number);
  failures.delete(number);
  updateStatus();
  try {
    const result = await api(`/api/drawers/${number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, changes })
    });
    const current = pending.get(number);
    const drawer = drawers.find(item => item.number === number);
    for (const [field, saved] of snapshot) {
      const latest = current?.get(field);
      if (latest && same(latest.value, saved.value)) {
        current.delete(field);
      } else if (latest) {
        latest.base = clone(result.drawer[field]);
      }
    }
    // Merge other clients' changes only into untouched fields; never replace an active draft.
    for (const field of fields) {
      if (!current?.has(field)) {
        drawer[field] = clone(result.drawer[field]);
        const value = field === 'searchTag' ? drawer[field].join(',') : drawer[field];
        if (rows.get(number).inputs[field].value !== value) rows.get(number).inputs[field].value = value;
      }
    }
    if (current?.size === 0) pending.delete(number);
    if (selectedNumber === number) elements.selected.textContent = `${number} · ${drawer.position} · ${drawer.title}`;
  } catch (error) {
    failures.set(number, error.message);
    clearTimeout(timers.get(number));
    timers.delete(number);
  } finally {
    inFlight.delete(number);
    if (pending.has(number) && !failures.has(number) && !timers.has(number)) schedule(number);
    updateStatus();
  }
}

function select(drawer) {
  rows.get(selectedNumber)?.element.classList.remove('selected');
  selectedNumber = drawer.number;
  rows.get(selectedNumber).element.classList.add('selected');
  elements.selected.textContent = `${drawer.number} · ${drawer.position} · ${drawer.title}`;
  elements['source-label'].textContent = drawer.sourceLabel ? `Source label: ${drawer.sourceLabel}` : 'No readable source label.';
  elements['photo-name'].textContent = drawer.photo || '';
  elements.photo.hidden = !drawer.photo;
  elements['photo-link'].hidden = !drawer.photo;
  elements['photo-message'].hidden = Boolean(drawer.photo);
  if (drawer.photo) {
    elements.photo.alt = `Source photo for drawer ${drawer.number}, position ${drawer.position}`;
    elements.photo.src = drawer.photo;
    elements['photo-link'].href = drawer.photo;
  } else {
    elements.photo.removeAttribute('src');
    elements['photo-link'].removeAttribute('href');
    elements['photo-message'].textContent = 'This planned drawer does not exist yet; no photo is available.';
  }
}

function filter() {
  const words = elements.search.value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const drawer of drawers) {
    const text = [drawer.number, drawer.position, drawer.title, drawer.description, drawer.remark, ...drawer.searchTag].join(' ').toLocaleLowerCase();
    const matches = words.every(word => text.includes(word));
    rows.get(drawer.number).element.hidden = !matches;
    if (matches) visible++;
  }
  elements.count.textContent = `${visible} / ${drawers.length} drawers`;
  elements.empty.hidden = visible > 0;
}

function render() {
  rows.clear();
  elements.drawers.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const drawer of drawers) {
    const tr = document.createElement('tr');
    tr.dataset.number = drawer.number;
    const cell = tr.insertCell();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'drawer-number';
    button.textContent = drawer.number;
    button.setAttribute('aria-label', `Select drawer ${drawer.number}`);
    button.addEventListener('click', () => select(drawer));
    const position = document.createElement('small');
    position.textContent = drawer.position;
    const rowStatus = document.createElement('small');
    rowStatus.className = 'row-status';
    cell.append(button, position, rowStatus);
    const inputs = {};
    for (const field of fields) {
      const input = document.createElement(field === 'title' || field === 'searchTag' ? 'input' : 'textarea');
      if (input instanceof HTMLInputElement) input.type = 'text';
      input.value = field === 'searchTag' ? drawer.searchTag.join(',') : drawer[field];
      input.dataset.field = field;
      input.maxLength = 20000;
      input.setAttribute('aria-label', `${field === 'searchTag' ? 'Tags' : field} for drawer ${drawer.number}`);
      input.addEventListener('focus', () => select(drawer));
      input.addEventListener('input', () => edit(drawer, field, field === 'searchTag' ? (input.value === '' ? [] : input.value.split(',')) : input.value));
      inputs[field] = input;
      tr.insertCell().append(input);
    }
    rows.set(drawer.number, { element: tr, status: rowStatus, inputs });
    fragment.append(tr);
  }
  elements.drawers.append(fragment);
  filter();
  select(drawers.find(drawer => drawer.number === selectedNumber) || drawers.find(drawer => drawer.number === '101') || drawers[0]);
}

async function load() {
  const result = await api('/api/drawers');
  drawers = result.drawers;
  render();
  elements.search.disabled = false;
  elements.export.disabled = false;
  updateStatus();
}

elements.search.addEventListener('input', filter);
elements.save.addEventListener('click', () => {
  for (const number of pending.keys()) void saveDrawer(number);
});
elements.reload.addEventListener('click', async () => {
  if (pending.size && !confirm('Discard unsaved edits and load the latest inventory? Export JSON first if you need to keep your edits.')) return;
  elements.reload.disabled = true;
  elements.save.disabled = true;
  elements.search.disabled = true;
  for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.disabled = true;
  try {
    const result = await api('/api/drawers');
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    failures.clear();
    drawers = result.drawers;
    render();
    elements.search.disabled = false;
    elements.export.disabled = false;
    updateStatus();
  } catch (error) {
    status(`Reload failed: ${error.message} Existing edits have been retained.`, true);
    elements.reload.disabled = false;
    elements.save.disabled = pending.size === 0;
    elements.search.disabled = drawers.length === 0;
    for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.disabled = false;
  }
});
elements.export.addEventListener('click', () => {
  const blob = new Blob([`${JSON.stringify(drawers, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'drawers.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
elements.photo.addEventListener('error', () => {
  elements.photo.hidden = true;
  elements['photo-message'].hidden = false;
  elements['photo-message'].textContent = 'Photo could not be loaded. Check that the image exists in html/images.';
});
elements.photo.addEventListener('load', () => {
  elements.photo.hidden = false;
  elements['photo-message'].hidden = true;
});
window.addEventListener('beforeunload', event => {
  if (pending.size || inFlight.size) {
    event.preventDefault();
    event.returnValue = '';
  }
});
try {
  await load();
} catch (error) {
  status(`Could not load inventory: ${error.message} Start the local server and reload the page.`, true);
  elements.reload.disabled = false;
}
