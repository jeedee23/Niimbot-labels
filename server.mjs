import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createInventoryStore, InventoryError } from './lib/inventory.mjs';
import { drawerPhotoPattern } from './lib/inventory-schema.mjs';
import { validatePhotoUpload, maximumPhotoBodyBytes } from './lib/photo-upload.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/label.js', ['label.js', 'text/javascript; charset=utf-8']],
  ['/label-pdf.bundle.js', ['label-pdf.bundle.js', 'text/javascript; charset=utf-8']],
  ['/label-print.bundle.js', ['label-print.bundle.js', 'text/javascript; charset=utf-8']],
  ['/fonts/NotoSansMono-Regular.ttf', ['fonts/NotoSansMono-Regular.ttf', 'font/ttf']],
  ['/fonts/NotoSansMono-Bold.ttf', ['fonts/NotoSansMono-Bold.ttf', 'font/ttf']],
  ['/selection.js', ['selection.js', 'text/javascript; charset=utf-8']],
  ['/search.js', ['search.js', 'text/javascript; charset=utf-8']],
  ['/keyboard.js', ['keyboard.js', 'text/javascript; charset=utf-8']],
  ['/printer-presence.js', ['printer-presence.js', 'text/javascript; charset=utf-8']],
  ['/photo-upload.js', ['photo-upload.js', 'text/javascript; charset=utf-8']],
  ['/images/dummy.jpg', ['images/dummy.jpg', 'image/jpeg']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readBody(request, maximumSize = 512 * 1024) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new InventoryError(415, 'Content-Type must be application/json.');
  }
  let size = 0;
  const chunks = [];
  const body = await new Promise((resolveBody, rejectBody) => {
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maximumSize) {
        chunks.length = 0;
        rejectBody(new InventoryError(413, 'Request is too large.'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
    request.on('aborted', () => rejectBody(new InventoryError(400, 'Request was interrupted.')));
  });
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new InventoryError(400, 'Invalid JSON request.');
    throw error;
  }
}

export function createApp({ inventoryPath = join(root, 'drawers.json'), htmlPath = join(root, 'html') } = {}) {
  const store = createInventoryStore(inventoryPath);
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const expectedPort = request.socket.localPort;
      const allowedHosts = [`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`];
      if (!allowedHosts.includes(request.headers.host)) throw new InventoryError(403, 'Only localhost access is allowed.');
      const origin = `http://${request.headers.host}`;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          request.headers['sec-fetch-site'] === 'cross-site') {
        throw new InventoryError(403, 'Cross-origin access is not allowed.');
      }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/api/drawers') {
        sendJson(response, 200, { drawers: await store.read() });
        return;
      }
      const match = /^\/api\/drawers\/(\d{3})$/.exec(url.pathname);
      const photoMatch = /^\/api\/drawers\/(\d{3})\/photo$/.exec(url.pathname);
      if (request.method === 'POST' && photoMatch) {
        const payload = await readBody(request, maximumPhotoBodyBytes);
        const image = validatePhotoUpload(payload);
        const photo = `images/drawer_${photoMatch[1]}_${randomUUID().replaceAll('-', '')}.${image.extension}`;
        const path = join(htmlPath, photo);
        await writeFile(path, image.bytes, { flag: 'wx' });
        let saved = false;
        try {
          const result = await store.setPhoto(photoMatch[1], payload.basePhoto, photo,
            oldPhoto => rm(join(htmlPath, oldPhoto), { force: true }));
          saved = true;
          sendJson(response, 200, result);
        } finally {
          if (!saved) await rm(path, { force: true });
        }
        return;
      }
      if (request.method === 'PATCH' && match) {
        sendJson(response, 200, await store.patch(match[1], await readBody(request)));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new InventoryError(405, 'Method not allowed.');
      }
      let asset = staticFiles.get(url.pathname);
      const uploadedPhoto = /^\/api\/photos\/([^/]+)$/.exec(url.pathname);
      if (uploadedPhoto && drawerPhotoPattern.test(`images/${uploadedPhoto[1]}`)) {
        asset = [`images/${uploadedPhoto[1]}`, uploadedPhoto[1].endsWith('.png') ? 'image/png' : 'image/jpeg'];
      }
      if (/^\/images\/MVIMG_\d{8}_\d{6}\.jpg$/.test(url.pathname)) {
        asset = [url.pathname.slice(1), 'image/jpeg'];
      }
      if (!asset) throw new InventoryError(404, 'Not found.');
      let content;
      try {
        content = await readFile(join(htmlPath, asset[0]));
      } catch (error) {
        if (error.code === 'ENOENT') throw new InventoryError(404, 'File not found.');
        throw error;
      }
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error instanceof InventoryError ? error.status : 500;
      if (status >= 500) console.error('Inventory request failed:', error);
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, status, { error: status >= 500 ? 'Inventory could not be read or saved. Check the server log.' : error.message });
      }
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  await createInventoryStore(join(root, 'drawers.json')).read();
  const server = createApp();
  server.on('error', error => {
    console.error('Could not start the local inventory server:', error);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Drawer editor: http://127.0.0.1:${port}`));
}
