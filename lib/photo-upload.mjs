import { InventoryError, validPhoto } from './inventory-schema.mjs';

export const maximumPhotoBytes = 1024 * 1024;
export const maximumPhotoBodyBytes = 1536 * 1024;

export function validatePhotoUpload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 3 || !Object.hasOwn(payload, 'basePhoto') ||
      !validPhoto(payload.basePhoto) || !['image/jpeg', 'image/png'].includes(payload.type) ||
      typeof payload.content !== 'string' ||
      payload.content.length > Math.ceil(maximumPhotoBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.content)) {
    throw new InventoryError(400, 'Provide basePhoto, PNG/JPEG type and base64 image content of at most 1 MB.');
  }
  const bytes = Uint8Array.from(atob(payload.content), character => character.charCodeAt(0));
  if (bytes.length > maximumPhotoBytes) throw new InventoryError(413, 'The compressed photo exceeds 1 MB.');
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const valid = payload.type === 'image/png'
    ? bytes.length >= 45 && png.every((value, index) => bytes[index] === value) &&
      [73, 72, 68, 82].every((value, index) => bytes[12 + index] === value) &&
      [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((value, index) => bytes[bytes.length - 12 + index] === value)
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (!valid) throw new InventoryError(400, 'The image content is not a supported PNG or JPEG file.');
  return { bytes, extension: payload.type === 'image/png' ? 'png' : 'jpg' };
}
