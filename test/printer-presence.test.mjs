import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrinterPort, monitorPrinterPresence, printerUsbFilter } from '../html/printer-presence.js';

function fixture() {
  const listeners = new Map();
  const reports = [];
  const errors = [];
  let available = [];
  const serial = {
    async getPorts() { return available; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    }
  };
  const port = { getInfo: () => printerUsbFilter, open() { throw new Error('Presence must never open a port'); } };
  const monitor = monitorPrinterPresence(serial, count => reports.push(count), error => errors.push(error));
  return { serial, port, monitor, listeners, reports, errors, available(ports) { available = ports; } };
}

test('printer matching uses USB identifiers, not hard-coded Windows COM names', () => {
  assert.equal(isPrinterPort({ getInfo: () => printerUsbFilter }), true);
  assert.equal(isPrinterPort({ getInfo: () => ({ usbVendorId: 0x3513, usbProductId: 3 }) }), false);
  assert.equal(isPrinterPort({ getInfo: () => ({}) }), false);
  assert.equal(isPrinterPort(null), false);
});

test('detects authorized printer without opening it and reports unplug/replug before any print connection', async () => {
  const f = fixture();
  f.available([f.port]);
  await f.monitor.refresh();
  assert.deepEqual(f.reports, [1]);
  f.listeners.get('disconnect')({ target: f.port });
  assert.deepEqual(f.reports, [1, 0]);
  f.listeners.get('connect')({ target: f.port });
  assert.deepEqual(f.reports, [1, 0, 1]);
  assert.deepEqual(f.errors, []);
});

test('ignores other USB devices and filters authorized ports known to be physically disconnected', async () => {
  const f = fixture();
  const other = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  f.available([other, { ...f.port, connected: false }]);
  await f.monitor.refresh();
  f.listeners.get('connect')({ port: other });
  f.listeners.get('disconnect')({ port: other });
  assert.deepEqual(f.reports, [0]);
  f.monitor.remember(f.port);
  f.listeners.get('disconnect')({ port: f.port });
  assert.deepEqual(f.reports, [0, 1, 0]);
});

test('late enumeration cannot overwrite an unplug warning or a newer permission grant', async () => {
  const f = fixture();
  f.monitor.remember(f.port);
  let finish;
  f.serial.getPorts = () => new Promise(resolve => { finish = resolve; });
  const scan = f.monitor.refresh();
  f.listeners.get('disconnect')({ target: f.port });
  finish([f.port]);
  await scan;
  assert.deepEqual(f.reports, [1, 0]);
  const nextScan = f.monitor.refresh();
  f.monitor.remember(f.port);
  finish([]);
  await nextScan;
  assert.deepEqual(f.reports, [1, 0, 1]);
});

test('enumeration errors are explicit and stopping removes listeners and invalidates in-flight scans', async () => {
  const f = fixture();
  f.serial.getPorts = async () => { throw new Error('Permission denied'); };
  await f.monitor.refresh();
  assert.equal(f.errors[0].message, 'Permission denied');
  assert.deepEqual(f.reports, []);
  let finish;
  f.serial.getPorts = () => new Promise(resolve => { finish = resolve; });
  const scan = f.monitor.refresh();
  f.monitor.stop();
  finish([f.port]);
  await scan;
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.reports, []);
});
