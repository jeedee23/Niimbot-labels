const fields = ['title', 'description', 'searchTag', 'remark'];
const delay = 10000;
const elements = Object.fromEntries([
  'drawers', 'search', 'count', 'status', 'save', 'reload', 'export', 'empty',
  'search-form', 'search-button', 'edit-drawer', 'editor', 'editor-heading', 'editor-fields',
  'editor-save', 'done-editing', 'results', 'keyboard', 'keyboard-status',
  'fullscreen', 'fullscreen-status', 'more-actions',
  'selected', 'source-label', 'photo', 'photo-link', 'photo-message', 'photo-name',
  'new-photo', 'photo-file', 'photo-status',
  'make-label', 'label-status', 'selection-count', 'clear-selection', 'select-visible',
  'connect-printer', 'print-labels', 'disconnect-printer', 'printer-status', 'printer-presence'
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
let printerClient = null;
let printerBusy = false;
let photoUploading = false;
let photoTarget = null;
const serialSupported = window.isSecureContext && typeof navigator.serial?.requestPort === 'function';
const printerPresence = serialSupported ? monitorPrinterPresence(navigator.serial, count => {
  elements['printer-presence'].textContent = count ?
    `USB printer present${count > 1 ? ` (${count} devices)` : ''}` :
    'USB printer absent or not authorized - check cable/power.';
  elements['printer-presence'].classList.toggle('error', count === 0);
}, error => {
  console.error('Could not check USB printer presence:', error);
  elements['printer-presence'].textContent = `Could not check USB printer: ${error.message}`;
  elements['printer-presence'].classList.add('error');
}) : null;
if (printerPresence) {
  void printerPresence.refresh();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void printerPresence.refresh();
  });
} else {
  elements['printer-presence'].textContent = 'USB detection unavailable in this browser.';
  elements['printer-presence'].classList.add('error');
}
let editorNumber = null;
let reloading = false;
const keyboard = createKeyboard(elements.keyboard, {
  onSearch: () => elements['search-form'].requestSubmit(),
  onError: message => {
    elements['keyboard-status'].hidden = false;
    elements['keyboard-status'].classList.add('error');
    elements['keyboard-status'].textContent = message;
  }
});

function canEdit() {
  return !readOnly && !reloading && drawers.length > 0;
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
  elements['print-labels'].textContent = selectedNumbers.size ? `Print selected (${selectedNumbers.size})` : 'Print selected labels';
  elements['edit-drawer'].disabled = !canEdit() || selectedNumbers.size !== 1;
  if (editorNumber && (selectedNumbers.size !== 1 || !selectedNumbers.has(editorNumber))) closeEditor();
  updatePrinterControls();
  elements['clear-selection'].disabled = selectedNumbers.size === 0;
  elements['select-visible'].disabled = visible.length === 0;
  elements['select-visible'].checked = visible.length > 0 && visibleSelected === visible.length;
  elements['select-visible'].indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  for (const [number, row] of rows) {
    const checked = selectedNumbers.has(number);
    row.checkbox.checked = checked;
    row.element.classList.toggle('selected', checked);
    row.selectButton.setAttribute('aria-pressed', String(checked));
  }
  if (selectedNumbers.size !== 1) clearPhoto();
  else if (!selectedNumber) select(drawers.find(drawer => selectedNumbers.has(drawer.number)));
}

function updatePrinterControls() {
  const connected = printerClient?.isConnected() === true;
  elements['connect-printer'].disabled = !serialSupported || printerBusy || connected;
  elements['disconnect-printer'].disabled = printerBusy || !connected;
  elements['print-labels'].disabled = !serialSupported || printerBusy || selectedNumbers.size === 0;
}

function printerStatus(message, error = false) {
  elements['printer-status'].textContent = message;
  elements['printer-status'].classList.toggle('error', error);
}

updatePrinterControls();
if (!serialSupported) printerStatus('USB printing is unavailable. Open this page in desktop Chrome or Edge using HTTPS or localhost.', true);

async function connectPrinter() {
  if (printerClient?.isConnected()) return;
  printerStatus('Connecting to the M2-H USB printer...');
  let port;
  try {
    const authorized = (await navigator.serial.getPorts()).filter(candidate => isPrinterPort(candidate) && candidate.connected !== false);
    // Ask only when no unambiguous authorized device exists, before loading the print bundle.
    port = authorized.length === 1 ? authorized[0] :
      await navigator.serial.requestPort({ filters: [printerUsbFilter] });
    printerPresence.remember(port);
    const { NiimbotSerialClient, validatePrinter } = await import('./label-print.bundle.js');
    printerClient = new NiimbotSerialClient();
    printerClient.setHeartbeatAutoStart(false);
    printerClient.on('packetsent', event => console.debug('NIIMBOT TX', event.packet.toBytes()));
    printerClient.on('packetreceived', event => console.debug('NIIMBOT RX', event.packet.toBytes()));
    printerClient.on('disconnect', () => {
      printerStatus('Printer disconnected. Reconnect before printing.', true);
      updatePrinterControls();
    });
    await printerClient.connect({ authorizedPort: port });
    validatePrinter(printerClient);
    printerStatus('M2-H connected by USB. Click Print selected labels to print immediately.');
  } catch (error) {
    console.error('Could not connect printer:', error);
    let cleanupError;
    try {
      if (printerClient) await printerClient.disconnect();
      else if (port?.readable) await port.close();
    } catch (failure) {
      cleanupError = failure;
      console.error('Could not release printer port:', failure);
    }
    printerClient = null;
    throw new Error(`Could not connect: ${error.message} Close the Niimbot app and other printer tabs, then retry.${cleanupError ? ` Port cleanup failed: ${cleanupError.message} Unplug/reconnect USB before retrying.` : ''}`);
  }
}

elements['connect-printer'].addEventListener('click', async () => {
  if (printerBusy || !serialSupported || printerClient?.isConnected()) return;
  printerBusy = true;
  updatePrinterControls();
  try {
    await connectPrinter();
  } catch (error) {
    printerStatus(error.message, true);
  } finally {
    printerBusy = false;
    updatePrinterControls();
  }
});
elements['disconnect-printer'].addEventListener('click', async () => {
  if (printerBusy || !printerClient) return;
  printerBusy = true;
  updatePrinterControls();
  try {
    await printerClient.disconnect();
    printerClient = null;
    printerStatus('Printer disconnected; the USB serial port is released.');
  } catch (error) {
    console.error('Could not disconnect printer:', error);
    printerStatus(`Could not disconnect: ${error.message} Unplug/reconnect USB if the port stays busy.`, true);
  } finally {
    printerBusy = false;
    updatePrinterControls();
  }
});
elements['print-labels'].addEventListener('click', async () => {
  if (printerBusy || !serialSupported) return;
  const selected = drawers.filter(item => selectedNumbers.has(item.number)).map(drawer => ({ ...drawer }));
  if (!selected.length) return;
  printerBusy = true;
  updatePrinterControls();
  let printAttempted = false;
  try {
    await connectPrinter();
    const { printSelectedLabels } = await import('./label-print.bundle.js');
    printAttempted = true;
    await printSelectedLabels(printerClient, selected, printerStatus);
    printerStatus(`Printer confirmed completion of ${selected.length} label(s). Check size, orientation and alignment before printing more.`);
  } catch (error) {
    console.error('Label printing failed:', error);
    printerStatus(`Printing failed: ${error.message} ${printAttempted ? 'Some labels may already have printed. Check the printer before retrying;' : 'No labels were sent;'} there is no automatic retry.`, true);
  } finally {
    printerBusy = false;
    updatePrinterControls();
  }
});

function choose(drawer, event, toggle = false) {
  const result = selectNumbers(selectedNumbers, visibleNumbers(), drawer.number, selectionAnchor, {
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, toggle
  });
  selectedNumbers = result.selected;
  selectionAnchor = result.anchor;
  updateSelection();
  select(drawer);
}

function updateRow(drawer) {
  const row = rows.get(drawer.number);
  row.title.textContent = drawer.title;
  row.description.textContent = drawer.description;
  row.selectButton.setAttribute('aria-label', `Drawer ${drawer.number}, ${drawer.title}, position ${drawer.position}`);
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
  elements['editor-save'].disabled = !canEdit() || !pending.has(editorNumber) || inFlight.has(editorNumber);
  elements['edit-drawer'].disabled = !canEdit() || selectedNumbers.size !== 1;
  elements.reload.disabled = reloading || photoUploading || inFlight.size > 0;
  elements['new-photo'].disabled = !canEdit() || photoUploading || !selectedNumber;
  elements['search-button'].disabled = reloading || drawers.length === 0;
  for (const [number, row] of rows) {
    row.element.classList.toggle('dirty', pending.has(number));
    row.element.classList.toggle('failed', failures.has(number));
    row.status.textContent = failures.has(number) ? 'Save failed' : inFlight.has(number) ? 'Saving...' : pending.has(number) ? 'Unsaved' : '';
  }
  if (readOnly) {
    status('Hosted preview is read-only. Saving will be enabled after access protection and GitHub storage are configured.');
  } else if (failures.size) {
    const [number, message] = failures.entries().next().value;
    status(`${number}: ${message} Unsaved edits remain available in Export JSON.`, true);
  } else if (inFlight.size) {
    status(`Saving ${inFlight.size} drawer(s)...`);
  } else if (pending.size) {
    status(`${pending.size} drawer(s) have unsaved changes. Saving after 10 seconds without typing, including search.`);
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

document.addEventListener('input', event => {
  if (event.target !== elements.search && !(event.target instanceof HTMLTextAreaElement)) return;
  for (const number of pending.keys()) {
    if (!failures.has(number)) schedule(number);
  }
});

function edit(drawer, field, value) {
  if (!canEdit()) {
    rows.get(drawer.number).inputs[field].value = field === 'searchTag' ? drawer[field].join(',') : drawer[field];
    status('This inventory is read-only or reloading. No edit was saved.', true);
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
  updateRow(drawer);
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
    updateRow(drawer);
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

function clearPhoto() {
  rows.get(selectedNumber)?.element.classList.remove('active');
  selectedNumber = null;
  elements.selected.textContent = '';
  elements['new-photo'].disabled = true;
  elements.photo.hidden = true;
  elements.photo.removeAttribute('src');
  elements['photo-link'].hidden = true;
  elements['photo-link'].removeAttribute('href');
  elements['photo-message'].hidden = true;
  elements['source-label'].textContent = '';
  elements['photo-name'].textContent = '';
}

function select(drawer) {
  if (selectedNumbers.size !== 1) {
    clearPhoto();
    return;
  }
  if (!selectedNumbers.has(drawer.number)) {
    drawer = drawers.find(item => selectedNumbers.has(item.number));
  }
  rows.get(selectedNumber)?.element.classList.remove('active');
  selectedNumber = drawer.number;
  rows.get(selectedNumber).element.classList.add('active');
  elements.selected.textContent = `${drawer.number} · ${drawer.position} · ${drawer.title}`;
  elements['new-photo'].disabled = !canEdit() || photoUploading;
  elements['source-label'].textContent = drawer.sourceLabel ? `Source label: ${drawer.sourceLabel}` : 'No readable source label.';
  elements['photo-name'].textContent = drawer.photo || '';
  elements.photo.hidden = false;
  elements['photo-link'].hidden = false;
  elements['photo-message'].hidden = Boolean(drawer.photo);
  if (drawer.photo) {
    elements.photo.alt = `Source photo for drawer ${drawer.number}, position ${drawer.position}`;
    const photoUrl = /^images\/drawer_\d{3}_/.test(drawer.photo) ? `/api/photos/${drawer.photo.slice(7)}` : drawer.photo;
    elements.photo.src = photoUrl;
    elements['photo-link'].href = photoUrl;
  } else {
    elements.photo.alt = `No photo for drawer ${drawer.number}. Touch to add an image.`;
    elements.photo.src = 'images/dummy.jpg';
    elements['photo-link'].href = 'images/dummy.jpg';
    elements['photo-message'].textContent = 'No drawer photo yet. Touch the placeholder to add one.';
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
  updateSelection();
}

function render() {
  closeEditor();
  rows.clear();
  elements.drawers.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const drawer of drawers) {
    const tr = document.createElement('div');
    tr.className = 'drawer-row';
    tr.setAttribute('role', 'listitem');
    tr.dataset.number = drawer.number;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select drawer ${drawer.number}`);
    checkbox.addEventListener('click', event => {
      event.stopPropagation();
      choose(drawer, event, true);
    });
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'drawer-select';
    const number = document.createElement('span');
    number.className = 'drawer-number';
    number.textContent = drawer.number;
    const position = document.createElement('span');
    position.className = 'drawer-position';
    position.textContent = drawer.position;
    const rowStatus = document.createElement('small');
    rowStatus.className = 'row-status';
    const text = document.createElement('span');
    text.className = 'drawer-text';
    const title = document.createElement('span');
    title.className = 'drawer-title';
    const description = document.createElement('span');
    description.className = 'drawer-description';
    text.append(title, description, rowStatus);
    selectButton.append(number, position, text);
    tr.append(checkbox, selectButton);
    selectButton.addEventListener('click', event => choose(drawer, event));
    selectButton.addEventListener('focus', () => select(drawer));
    selectButton.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) choose(drawer, event, event.key === ' ');
      }
    });
    const inputs = {};
    for (const field of fields) {
      const input = document.createElement('textarea');
      input.rows = 1;
      input.readOnly = !canEdit();
      input.inputMode = 'none';
      input.value = field === 'searchTag' ? drawer.searchTag.join(',') : drawer[field];
      input.dataset.field = field;
      input.maxLength = 20000;
      input.setAttribute('aria-label', `${field === 'searchTag' ? 'Tags' : field} for drawer ${drawer.number}`);
      input.addEventListener('focus', () => select(drawer));
      input.addEventListener('input', () => edit(drawer, field, field === 'searchTag' ? (input.value === '' ? [] : input.value.split(',')) : input.value));
      inputs[field] = input;
    }
    rows.set(drawer.number, { element: tr, status: rowStatus, inputs, checkbox, selectButton, title, description });
    updateRow(drawer);
    fragment.append(tr);
  }
  elements.drawers.append(fragment);
  filter();
  if (selectedNumbers.size) select(drawers.find(drawer => drawer.number === selectedNumber) ||
    drawers.find(drawer => selectedNumbers.has(drawer.number)));
}

async function load() {
  const result = await api('/api/drawers');
  drawers = result.drawers;
  readOnly = result.readOnly === true;
  render();
  elements.search.disabled = false;
  elements.export.disabled = false;
  updateStatus();
  keyboard.focusTarget(elements.search);
}

elements.search.addEventListener('input', filter);
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  closeEditor();
  filter();
  keyboard.focusTarget(elements.search);
});

function closeEditor() {
  editorNumber = null;
  elements.editor.hidden = true;
  elements.results.hidden = false;
  elements['editor-fields'].replaceChildren();
  if (elements.search.disabled) keyboard.clearTarget();
  else keyboard.focusTarget(elements.search);
}

elements['edit-drawer'].addEventListener('click', () => {
  if (!canEdit() || selectedNumbers.size !== 1) return;
  editorNumber = [...selectedNumbers][0];
  const drawer = drawers.find(item => item.number === editorNumber);
  select(drawer);
  elements['editor-heading'].textContent = `Edit ${drawer.number}`;
  elements['editor-fields'].replaceChildren();
  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'editor-field';
    const caption = document.createElement('span');
    caption.textContent = field === 'searchTag' ? 'Tags (comma-separated)' : field[0].toUpperCase() + field.slice(1);
    const input = rows.get(editorNumber).inputs[field];
    input.readOnly = false;
    label.append(caption, input);
    elements['editor-fields'].append(label);
  }
  elements.results.hidden = true;
  elements.editor.hidden = false;
  updateStatus();
  keyboard.focusTarget(rows.get(editorNumber).inputs.title);
});
elements['done-editing'].addEventListener('click', () => {
  closeEditor();
  filter();
  keyboard.focusTarget(elements.search);
});
elements['editor-save'].addEventListener('click', () => {
  if (editorNumber) void saveDrawer(editorNumber);
});
document.addEventListener('focusin', event => {
  if (event.target === elements.search || event.target instanceof HTMLTextAreaElement) {
    elements['keyboard-status'].hidden = true;
  }
});
document.addEventListener('input', event => {
  if (event.target === elements.search || event.target instanceof HTMLTextAreaElement) elements['keyboard-status'].hidden = true;
});

function updateFullscreen() {
  const active = Boolean(document.fullscreenElement);
  elements.fullscreen.textContent = active ? 'Exit full screen' : 'Full screen';
  elements.fullscreen.setAttribute('aria-pressed', String(active));
}
elements.fullscreen.disabled = !document.fullscreenEnabled;
if (!document.fullscreenEnabled) {
  elements['fullscreen-status'].hidden = false;
  elements['fullscreen-status'].textContent = 'Fullscreen is unavailable here; use F11 in desktop Chrome/Edge.';
}
elements.fullscreen.addEventListener('click', async () => {
  const entering = !document.fullscreenElement;
  elements['fullscreen-status'].hidden = false;
  elements['fullscreen-status'].classList.remove('error');
  elements['fullscreen-status'].textContent = entering ? 'Entering full screen...' : 'Leaving full screen...';
  const timeout = setTimeout(() => {
    updateFullscreen();
    elements['fullscreen-status'].hidden = false;
    elements['fullscreen-status'].classList.add('error');
    elements['fullscreen-status'].textContent = 'The browser did not complete the fullscreen request. Press F11 to toggle browser fullscreen, or reload after saving your changes.';
  }, 5000);
  try {
    if (entering) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    else await document.exitFullscreen();
    updateFullscreen();
    elements['fullscreen-status'].hidden = true;
  } catch (error) {
    console.error('Could not change fullscreen:', error);
    elements['fullscreen-status'].hidden = false;
    elements['fullscreen-status'].classList.add('error');
    elements['fullscreen-status'].textContent = `Could not change fullscreen: ${error.message}. Try F11.`;
  } finally {
    clearTimeout(timeout);
  }
});
document.addEventListener('fullscreenchange', updateFullscreen);
updateFullscreen();
elements['more-actions'].addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('button')) elements['more-actions'].open = false;
});
document.addEventListener('pointerdown', event => {
  if (!elements['more-actions'].contains(event.target)) elements['more-actions'].open = false;
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
  if (photoUploading || reloading || inFlight.size) return;
  if (pending.size && !confirm('Discard unsaved edits and load the latest inventory? Export JSON first if you need to keep your edits.')) return;
  reloading = true;
  elements.reload.disabled = true;
  elements.save.disabled = true;
  elements['edit-drawer'].disabled = true;
  elements['editor-save'].disabled = true;
  elements['search-button'].disabled = true;
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
    reloading = false;
    render();
    elements.search.disabled = false;
    elements.export.disabled = false;
    updateStatus();
    keyboard.focusTarget(elements.search);
  } catch (error) {
    reloading = false;
    status(`Reload failed: ${error.message} Existing edits have been retained.`, true);
    elements.reload.disabled = false;
    elements.save.disabled = !canEdit() || pending.size === 0 || inFlight.size > 0;
    elements['edit-drawer'].disabled = !canEdit() || selectedNumbers.size !== 1;
    elements['editor-save'].disabled = !canEdit() || !pending.has(editorNumber) || inFlight.has(editorNumber);
    elements['search-button'].disabled = drawers.length === 0;
    elements.search.disabled = drawers.length === 0;
    for (const row of rows.values()) for (const input of Object.values(row.inputs)) input.disabled = false;
  }
});
elements.export.addEventListener('click', () => {
  download(`${JSON.stringify(drawers, null, 2)}\n`, 'application/json', 'drawers.json');
});
function photoStatus(message, error = false) {
  elements['photo-status'].hidden = false;
  elements['photo-status'].textContent = message;
  elements['photo-status'].classList.toggle('error', error);
}
function choosePhoto() {
  if (photoUploading) return;
  if (!canEdit()) {
    photoStatus('This inventory is read-only or reloading. No image was uploaded.', true);
    return;
  }
  const drawer = drawers.find(item => item.number === selectedNumber);
  if (!drawer) return;
  if (!confirm(`New Image of THIS drawer only?\n\nDrawer ${drawer.number}: ${drawer.title}\nChoose OK to select a PNG/JPG, or Cancel.`)) return;
  photoTarget = { number: drawer.number, basePhoto: drawer.photo };
  elements['photo-file'].value = '';
  elements['photo-file'].click();
}
elements['photo-link'].addEventListener('click', event => {
  event.preventDefault();
  choosePhoto();
});
elements['new-photo'].addEventListener('click', choosePhoto);
elements['photo-file'].addEventListener('cancel', () => { photoTarget = null; });
elements['photo-file'].addEventListener('change', async () => {
  const file = elements['photo-file'].files[0];
  const target = photoTarget;
  photoTarget = null;
  if (!file || !target || photoUploading) return;
  if (!canEdit()) { photoStatus('This inventory is read-only. No image was uploaded.', true); return; }
  photoUploading = true;
  updateStatus();
  let uploadAttempted = false;
  try {
    photoStatus(`Preparing image for drawer ${target.number}...`);
    const { preparePhoto } = await import('./photo-upload.js');
    const image = await preparePhoto(file);
    photoStatus(`Uploading drawer ${target.number}: ${image.width} x ${image.height}, ${Math.ceil(image.bytes / 1024)} KB...`);
    uploadAttempted = true;
    const result = await api(`/api/drawers/${target.number}/photo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePhoto: target.basePhoto, type: image.type, content: image.content })
    });
    const drawer = drawers.find(item => item.number === target.number);
    drawer.photo = result.drawer.photo;
    if (selectedNumber === target.number) select(drawer);
    photoStatus(`New image saved for drawer ${target.number} only.${result.warning ? ` ${result.warning}` : ' Old image removed only if no drawers use it.'}`, Boolean(result.warning));
  } catch (error) {
    console.error('Drawer image upload failed:', error);
    photoStatus(`Could not upload image: ${error.message}${uploadAttempted ? ' Reload to check whether the upload completed before retrying.' : ' No upload was attempted.'}`, true);
  } finally {
    photoUploading = false;
    updateStatus();
  }
});
elements.photo.addEventListener('error', () => {
  if (!selectedNumber) return;
  elements['photo-message'].hidden = false;
  if (elements.photo.getAttribute('src') === 'images/dummy.jpg') {
    elements.photo.hidden = true;
    elements['photo-message'].textContent = 'The placeholder image could not be loaded. Use New image of this drawer.';
  } else {
    elements.photo.src = 'images/dummy.jpg';
    elements.photo.alt = 'Drawer photo unavailable. Touch to replace it.';
    elements['photo-message'].textContent = 'Photo could not be loaded. Touch the placeholder to replace it, or retry Reload.';
  }
});
elements.photo.addEventListener('load', () => {
  if (!selectedNumber) return;
  elements.photo.hidden = false;
  if (elements.photo.getAttribute('src') !== 'images/dummy.jpg') elements['photo-message'].hidden = true;
});
window.addEventListener('beforeunload', event => {
  if (pending.size || inFlight.size || printerBusy || photoUploading) {
    event.preventDefault();
    event.returnValue = '';
  }
});
try {
  await load();
} catch (error) {
  status(`Could not load inventory: ${error.message} Check your connection and sign-in, or start the server if using the local editor, then reload.`, true);
  elements.reload.disabled = false;
}
import { selectNumbers } from './selection.js';
import { createDrawerFilter } from './search.js';
import { createKeyboard } from './keyboard.js';
import { monitorPrinterPresence, isPrinterPort, printerUsbFilter } from './printer-presence.js';
