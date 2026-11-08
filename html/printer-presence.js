export const printerUsbFilter = { usbVendorId: 0x3513, usbProductId: 0x0002 };

export function isPrinterPort(port) {
  if (typeof port?.getInfo !== 'function') return false;
  const info = port.getInfo();
  return info.usbVendorId === printerUsbFilter.usbVendorId && info.usbProductId === printerUsbFilter.usbProductId;
}

export function monitorPrinterPresence(serial, report, reportError) {
  const ports = new Set();
  let revision = 0;
  const publish = () => report(ports.size);
  const remember = port => {
    if (!isPrinterPort(port)) return;
    revision++;
    ports.add(port);
    publish();
  };
  const connected = event => remember(event.port || event.target);
  const disconnected = event => {
    const port = event.port || event.target;
    if (!isPrinterPort(port)) return;
    revision++;
    ports.delete(port);
    publish();
  };
  async function refresh() {
    const currentRevision = ++revision;
    try {
      const authorized = await serial.getPorts();
      if (currentRevision !== revision) return;
      ports.clear();
      for (const port of authorized) {
        if (isPrinterPort(port) && port.connected !== false) ports.add(port);
      }
      publish();
    } catch (error) {
      if (currentRevision === revision) reportError(error);
    }
  }
  serial.addEventListener('connect', connected);
  serial.addEventListener('disconnect', disconnected);
  return {
    remember,
    refresh,
    stop() {
      revision++;
      serial.removeEventListener('connect', connected);
      serial.removeEventListener('disconnect', disconnected);
    }
  };
}
