export const editableFields = ['title', 'description', 'remark', 'searchTag'];
export const drawerPhotoPattern = /^images\/drawer_(\d{3})_[a-f0-9]{32}\.(jpg|png)$/;

export function validPhoto(photo) {
  return photo === null || (typeof photo === 'string' &&
    (/^images\/MVIMG_\d{8}_\d{6}\.jpg$/.test(photo) || drawerPhotoPattern.test(photo)));
}

export function unusedPhoto(drawers, photo) {
  return photo !== null && validPhoto(photo) && !drawers.some(drawer => drawer.photo === photo);
}

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
        !validPhoto(drawer.photo) ||
        (typeof drawer.photo === 'string' && drawerPhotoPattern.test(drawer.photo) && drawerPhotoPattern.exec(drawer.photo)[1] !== drawer.number) ||
        !(drawer.sourceLabel === null || typeof drawer.sourceLabel === 'string')) {
      throw new InventoryError(500, `Invalid inventory record at position ${n}.`);
    }

  });
  return drawers;
}

export function applyPhoto(drawers, number, basePhoto, photo) {
  const drawer = drawers.find(item => item.number === number);
  if (!drawer) throw new InventoryError(404, 'Drawer not found.');
  if (drawer.photo !== basePhoto) throw new InventoryError(409, 'This drawer photo was changed elsewhere. Reload to check its current image before uploading again.');
  if (!drawerPhotoPattern.test(photo) || drawerPhotoPattern.exec(photo)[1] !== number) {
    throw new InventoryError(400, 'The new image must belong to this drawer.');
  }
  drawer.photo = photo;
  return drawer;
}

export function validatePatch(payload) {
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
  return fields;
}

export function applyPatch(drawers, number, payload, fields = validatePatch(payload)) {
  const drawer = drawers.find(item => item.number === number);
  if (!drawer) throw new InventoryError(404, 'Drawer not found.');
  if (fields.some(field => JSON.stringify(drawer[field]) !== JSON.stringify(payload.base[field]))) {
    throw new InventoryError(409, 'This drawer was changed elsewhere. Your edits are retained. Export them before reloading and reconciling the changes.');
  }
  for (const field of fields) drawer[field] = payload.changes[field];
  return drawer;
}
