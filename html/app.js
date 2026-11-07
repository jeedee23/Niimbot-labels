const fields = ['title', 'description', 'searchTag', 'remark'];
const delay = 5000;
const editingPin = 'A1B2';
const editingSessionKey = 'niimbot-editing-unlocked';
const elements = Object.fromEntries([
  'drawers', 'search', 'count', 'status', 'save', 'reload', 'export', 'empty', 'enable-editing',
  'editing-dialog', 'editing-form', 'editing-pin', 'editing-error', 'cancel-editing',
  'selected', 'source-label', 'photo', 'photo-link', 'photo-message', 'photo-name',
  'make-label', 'label-status', 'selection-count', 'clear-selection', 'select-visible'
].map(id => [id, document.getElementById(id)]));
const rows = new Map();
const pending = new Map();
const timers = new Map();
const inFlight = new Set();
const failures = new Map();
let drawers = [];
let selectedNumber = null;
let readOnly = false;
let selectedNumbers = new Set();
let selectionAnchor = null;
let makingLabels = false;
let editingUnlocked = false;
let editingSessionError = '';
try {
  editingUnlocked = sessionStorage.getItem(editingSessionKey) === 'true';
} catch (error) {
  console.error('Could not restore editing session:', error);
  editingSessionError = 'Browser session storage is unavailable. Editing remains locked; allow session storage and try again.';
}

function canEdit() {
  return editingUnlocked && !readOnly;
}

function visibleNumbers() {
  return drawers.filter(drawer => !rows.get(drawer.number).element.hidden).map(drawer => drawer.number);
}

function updateSelection() {
  const visible = visibleNumbers();
  const visibleSelected = visible.filter(number => selectedNumbers.has(number)).length;
  const hidden = selectedNumbers.size - visibleSelected;
  elements['selection-count'].textContent = `${selectedNumbers.size} selected${hidden ? ` (${hidden} hidden)` : ''}`;
  elements['make-label'].disabled = makingLabels || selectedNumbers.size === 0;
  elements['clear-selection'].disabled = selectedNumbers.size === 0;
  elements['select-visible'].disabled = visible.length === 0;
  elements['select-visible'].checked = visible.length > 0 && visibleSelected === visible.length;
  elements['select-visible'].indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  for (const [number, row] of rows) {
    const checked = selectedNumbers.has(number);
    row.checkbox.checked = checked;
    row.element.classList.toggle('selected', checked);
    row.element.setAttribute('aria-selected', String(checked));
  }
}

function choose(drawer, event, toggle = false) {
  const result = selectNumbers(selectedNumbers, visibleNumbers(), drawer.number, selectionAnchor, {
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, toggle
  });
  selectedNumbers = result.selected;
  selectionAnchor = result.anchor;
  updateSelection();
  select(drawer);
}

function sizeRow(row) {
  if (!row || row.element.hidden) return;
  const inputs = Object.values(row.inputs);
  const borders = element => {
    const style = getComputedStyle(element);
    return parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  };
  for (const input of inputs) input.style.height = '0px';
  const height = Math.max(30 - borders(inputs[0].parentElement), ...inputs.map(input => input.scrollHeight + borders(input)));
  for (const input of inputs) input.style.height = `${height}px`;
}

function sizeVisibleRows() {
  for (const row of rows.values()) sizeRow(row);
}

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
  elements.save.disabled = !canEdit() || pending.size === 0 || inFlight.size > 0;
  elements['enable-editing'].disabled = readOnly || editingUnlocked || drawers.length === 0;
  elements['enable-editing'].textContent = canEdit() ? 'Editing enabled' : 'Enable editing';
  elements.reload.disabled = inFlight.size > 0;
  for (const [number, row] of rows) {
    row.element.classList.toggle('dirty', pending.has(number));
    row.element.classList.toggle('failed', failures.has(number));
    row.status.textContent = failures.has(number) ? 'Save failed' : inFlight.has(number) ? 'Saving...' : pending.has(number) ? 'Unsaved' : '';
  }
  if (readOnly) {
    status('Hosted preview is read-only. Saving will be enabled after access protection and GitHub storage are configured.');
  } else if (!editingUnlocked) {
    status(editingSessionError || 'Editing locked. Use Enable editing and enter the PIN to allow changes and saving.', Boolean(editingSessionError));
  } else if (failures.size) {
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
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('The inventory API did not return JSON. Your login may have expired; export unsaved edits before signing in again and reloading.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function schedule(number) {
  if (!canEdit()) return;
  clearTimeout(timers.get(number));
  timers.set(number, setTimeout(() => {
    timers.delete(number);
    void saveDrawer(number);
  }, delay));
}

function edit(drawer, field, value) {
  if (!canEdit()) {
    rows.get(drawer.number).inputs[field].value = field === 'searchTag' ? drawer[field].join(',') : drawer[field];
    return;
  }
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
  sizeRow(rows.get(drawer.number));
  if (selectedNumber === drawer.number) elements.selected.textContent = `${drawer.number} · ${drawer.position} · ${drawer.title}`;
  updateStatus();
}

async function saveDrawer(number) {
  if (!canEdit() || inFlight.has(number) || !pending.has(number)) return;
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
    sizeRow(rows.get(number));
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
  rows.get(selectedNumber)?.element.classList.remove('active');
  selectedNumber = drawer.number;
  rows.get(selectedNumber).element.classList.add('active');
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
  const matchesSearch = createDrawerFilter(elements.search.value);
  let visible = 0;
  for (const drawer of drawers) {
    const matches = matchesSearch(drawer);
    rows.get(drawer.number).element.hidden = !matches;
    if (matches) visible++;
  }
  elements.count.textContent = `${visible} / ${drawers.length} drawers`;
  elements.empty.hidden = visible > 0;
  sizeVisibleRows();
  updateSelection();
}

function render() {
  rows.clear();
  elements.drawers.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const drawer of drawers) {
    const tr = document.createElement('tr');
    tr.dataset.number = drawer.number;
    tr.tabIndex = 0;
    const selectionCell = tr.insertCell();
    selectionCell.className = 'selection-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select drawer ${drawer.number}`);
    checkbox.addEventListener('click', event => {
      event.stopPropagation();
      choose(drawer, event, true);
    });
    selectionCell.append(checkbox);
    const cell = tr.insertCell();
    cell.className = 'drawer-cell';
    const number = document.createElement('span');
    number.className = 'drawer-number';
    number.textContent = drawer.number;
    const position = tr.insertCell();
    position.className = 'position-cell';
    position.textContent = drawer.position;
    const rowStatus = document.createElement('small');
    rowStatus.className = 'row-status';
    cell.append(number, rowStatus);
    tr.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('textarea, input')) return;
      choose(drawer, event);
    });
    tr.addEventListener('focus', () => select(drawer));
    tr.addEventListener('keydown', event => {
      if (event.target === tr && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        choose(drawer, event, event.key === ' ');
      }
    });
    const inputs = {};
    for (const field of fields) {
      const input = document.createElement('textarea');
      input.rows = 1;
      input.readOnly = !canEdit();
      input.value = field === 'searchTag' ? drawer.searchTag.join(',') : drawer[field];
      input.dataset.field = field;
      input.maxLength = 20000;
      input.setAttribute('aria-label', `${field === 'searchTag' ? 'Tags' : field} for drawer ${drawer.number}`);
      input.addEventListener('focus', () => select(drawer));
      input.addEventListener('input', () => edit(drawer, field, field === 'searchTag' ? (input.value === '' ? [] : input.value.split(',')) : input.value));
      inputs[field] = input;
      tr.insertCell().append(input);
    }
    rows.set(drawer.number, { element: tr, status: rowStatus, inputs, checkbox });
    fragment.append(tr);
  }
  elements.drawers.append(fragment);
  filter();
  select(drawers.find(drawer => drawer.number === selectedNumber) || drawers.find(drawer => drawer.number === '101') || drawers[0]);
}

async function load() {
  const result = await api('/api/drawers');
  drawers = result.drawers;
  readOnly = result.readOnly === true;
  render();
  elements.search.disabled = false;
  elements.export.disabled = false;
  updateStatus();
}

elements.search.addEventListener('input', filter);
elements['enable-editing'].addEventListener('click', () => {
  if (readOnly || editingUnlocked || drawers.length === 0) return;
  elements['editing-pin'].value = '';
  elements['editing-error'].textContent = '';
  elements['editing-dialog'].showModal();
});
elements['cancel-editing'].addEventListener('click', () => elements['editing-dialog'].close());
elements['editing-form'].addEventListener('submit', event => {
  event.preventDefault();
  if (readOnly || editingUnlocked || drawers.length === 0) return;
  if (elements['editing-pin'].value !== editingPin) {
    elements['editing-error'].textContent = 'Incorrect PIN. Editing and saving remain locked.';
    elements['editing-pin'].select();
    return;
  }
  try {
    sessionStorage.setItem(editingSessionKey, 'true');
  } catch (error) {
    console.error('Could not store editing session:', error);
    elements['editing-error'].textContent = 'Could not enable editing: browser session storage is unavailable. Allow session storage and try again.';
    return;
  }
  editingUnlocked = true;
  editingSessionError = '';
  elements['editing-pin'].value = '';
  elements['editing-dialog'].close();
  for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.readOnly = false;
  updateStatus();
});
elements['clear-selection'].addEventListener('click', () => {
  selectedNumbers.clear();
  selectionAnchor = null;
  updateSelection();
});
elements['select-visible'].addEventListener('change', () => {
  const visible = visibleNumbers();
  for (const number of visible) {
    if (elements['select-visible'].checked) selectedNumbers.add(number);
    else selectedNumbers.delete(number);
  }
  selectionAnchor = visible[0] || null;
  updateSelection();
});
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
elements['make-label'].addEventListener('click', async () => {
  if (makingLabels) return;
  const selected = drawers.filter(item => selectedNumbers.has(item.number)).map(drawer => ({ ...drawer }));
  makingLabels = true;
  updateSelection();
  elements['label-status'].hidden = false;
  elements['label-status'].classList.remove('error');
  elements['label-status'].textContent = 'Creating labels.pdf...';
  try {
    const { createLabelsPdf } = await import('./label-pdf.bundle.js');
    const pdf = await createLabelsPdf(selected);
    download(pdf, 'application/pdf', 'labels.pdf');
    elements['label-status'].classList.remove('error');
    elements['label-status'].textContent = `Created labels.pdf: ${selected.length} page(s), one 50 x 30 mm label per drawer, in inventory order. Print at Actual size (100%).`;
  } catch (error) {
    elements['label-status'].classList.add('error');
    elements['label-status'].textContent = `Could not create labels.pdf: ${error.message}`;
  } finally {
    makingLabels = false;
    updateSelection();
  }
});
elements.save.addEventListener('click', () => {
  for (const number of pending.keys()) void saveDrawer(number);
});
elements.reload.addEventListener('click', async () => {
  if (pending.size && !confirm('Discard unsaved edits and load the latest inventory? Export JSON first if you need to keep your edits.')) return;
  elements.reload.disabled = true;
  elements.save.disabled = true;
  elements['enable-editing'].disabled = true;
  elements.search.disabled = true;
  for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.disabled = true;
  try {
    const result = await api('/api/drawers');
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    failures.clear();
    drawers = result.drawers;
    readOnly = result.readOnly === true;
    render();
    elements.search.disabled = false;
    elements.export.disabled = false;
    updateStatus();
  } catch (error) {
    status(`Reload failed: ${error.message} Existing edits have been retained.`, true);
    elements.reload.disabled = false;
    elements.save.disabled = !canEdit() || pending.size === 0 || inFlight.size > 0;
    elements['enable-editing'].disabled = readOnly || editingUnlocked || drawers.length === 0;
    elements.search.disabled = drawers.length === 0;
    for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.disabled = false;
  }
});
elements.export.addEventListener('click', () => {
  download(`${JSON.stringify(drawers, null, 2)}\n`, 'application/json', 'drawers.json');
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
let tableWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width !== tableWidth) {
    tableWidth = width;
    requestAnimationFrame(sizeVisibleRows);
  }
}).observe(elements.drawers.closest('table'));
try {
  await load();
} catch (error) {
  status(`Could not load inventory: ${error.message} Check your connection and sign-in, or start the server if using the local editor, then reload.`, true);
  elements.reload.disabled = false;
}
import { selectNumbers } from './selection.js';
import { createDrawerFilter } from './search.js';
