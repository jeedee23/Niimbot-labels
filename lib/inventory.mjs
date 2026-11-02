import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { applyPatch, validatePatch, validateInventory } from './inventory-schema.mjs';
export { editableFields, InventoryError, validateInventory } from './inventory-schema.mjs';

export function createInventoryStore(filePath) {
  let queue = Promise.resolve();

  async function read() {
    const text = await readFile(filePath, 'utf8');
    return validateInventory(JSON.parse(text));
  }

  async function patch(number, payload) {
    const fields = validatePatch(payload);

    const operation = queue.then(async () => {
      const drawers = await read();
      const drawer = applyPatch(drawers, number, payload, fields);
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
