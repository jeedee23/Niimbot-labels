import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';

export const editableFields = ['title', 'description', 'remark', 'searchTag'];

export class InventoryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validField(field, value) {
  return field === 'searchTag'
    ? Array.isArray(value) && value.length <= 200 && value.every(tag => typeof tag === 'string' && tag.length <= 20000)
    : typeof value === 'string' && value.length <= 20000;
}

export function validateInventory(drawers) {
  if (!Array.isArray(drawers) || drawers.length !== 210) {
    throw new InventoryError(500, 'Inventory must contain exactly 210 drawers.');
  }
  drawers.forEach((drawer, index) => {
    const n = index + 1;
    if (!drawer || drawer.number !== String(n).padStart(3, '0') ||
        drawer.position !== `L${Math.floor((n - 1) / 5) + 1}/${(n - 1) % 5 + 1}` ||
        !editableFields.every(field => validField(field, drawer[field])) ||
        !(drawer.photo === null || (typeof drawer.photo === 'string' && /^images\/MVIMG_\d{8}_\d{6}\.jpg$/.test(drawer.photo))) ||
        !(drawer.sourceLabel === null || typeof drawer.sourceLabel === 'string')) {
      throw new InventoryError(500, `Invalid inventory record at position ${n}.`);
    }
  });
  return drawers;
}

export function createInventoryStore(filePath) {
  let queue = Promise.resolve();

  async function read() {
    const text = await readFile(filePath, 'utf8');
    return validateInventory(JSON.parse(text));
  }

  async function patch(number, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !['base', 'changes'].includes(key)) ||
        !payload.changes || typeof payload.changes !== 'object' || Array.isArray(payload.changes) ||
        !payload.base || typeof payload.base !== 'object' || Array.isArray(payload.base)) {
      throw new InventoryError(400, 'Provide base and changes objects.');
    }
    const fields = Object.keys(payload.changes);
    if (fields.length === 0 || fields.some(field => !editableFields.includes(field) ||
        !validField(field, payload.changes[field]) || !validField(field, payload.base[field])) ||
        Object.keys(payload.base).length !== fields.length ||
        Object.keys(payload.base).some(field => !fields.includes(field))) {
      throw new InventoryError(400, 'Only title, description, remark and searchTag can be edited; include their original values.');
    }

    const operation = queue.then(async () => {
      const drawers = await read();
      const drawer = drawers.find(item => item.number === number);
      if (!drawer) throw new InventoryError(404, 'Drawer not found.');
      if (fields.some(field => JSON.stringify(drawer[field]) !== JSON.stringify(payload.base[field]))) {
        throw new InventoryError(409, 'This drawer was changed elsewhere. Your edits are retained. Export them before reloading and reconciling the changes.');
      }
      for (const field of fields) drawer[field] = payload.changes[field];
      const content = `${JSON.stringify(drawers, null, 2)}\n`;
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true });
      }
      return { drawer, revision: createHash('sha256').update(content).digest('hex') };
    });
    // Keep the write queue usable after a rejected request; its caller still receives the error.
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return { read, patch };
}
