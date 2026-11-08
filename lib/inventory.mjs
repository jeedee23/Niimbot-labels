import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { applyPatch, applyPhoto, unusedPhoto, validatePatch, validateInventory } from './inventory-schema.mjs';
export { editableFields, InventoryError, validateInventory } from './inventory-schema.mjs';

export function createInventoryStore(filePath) {
  let queue = Promise.resolve();

  async function read() {
    const text = await readFile(filePath, 'utf8');
    return validateInventory(JSON.parse(text));
  }

  async function patch(number, payload) {
    const fields = validatePatch(payload);
    return write(drawers => applyPatch(drawers, number, payload, fields));
  }

  function setPhoto(number, basePhoto, photo, removePhoto) {
    return write(drawers => applyPhoto(drawers, number, basePhoto, photo), async drawers => {
      if (removePhoto && unusedPhoto(drawers, basePhoto)) await removePhoto(basePhoto);
    });
  }

  function write(change, afterSave) {
    const operation = queue.then(async () => {
      const drawers = await read();
      const drawer = change(drawers);
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
      const result = { drawer, revision: createHash('sha256').update(content).digest('hex') };
      if (afterSave) {
        try {
          await afterSave(drawers);
        } catch (error) {
          console.error('Saved drawer photo, but old image cleanup failed:', error);
          result.warning = 'The new image is saved, but the unused old image could not be deleted. Check the server log.';
        }
      }
      return result;
    });
    // Keep the write queue usable after a rejected request; its caller still receives the error.
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return { read, patch, setPhoto };
}
