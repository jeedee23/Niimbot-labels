export const maximumPhotoBytes = 1024 * 1024;

export function resizedDimensions(width, height, longestSide = 1600) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The image has invalid dimensions.');
  const scale = Math.min(1, longestSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('The browser could not encode this image.'));
  }, type, quality));
}

export async function preparePhoto(file) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choose a PNG or JPG image.');
  if (file.size > 40 * 1024 * 1024) throw new Error('The original photo exceeds 40 MB. Resize it before choosing it.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('The original photo exceeds 40 megapixels. Resize it first.');
    const size = resizedDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    let context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create an image canvas.');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    let blob = file.type === 'image/png' ? await encode(canvas, 'image/png') : null;
    if (!blob || blob.size > maximumPhotoBytes) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (let attempt = 0; attempt < 8; attempt++) {
        blob = await encode(canvas, 'image/jpeg', Math.max(.55, .86 - attempt * .06));
        if (blob.size <= maximumPhotoBytes) break;
        const next = document.createElement('canvas');
        next.width = Math.max(1, Math.round(canvas.width * .8));
        next.height = Math.max(1, Math.round(canvas.height * .8));
        const nextContext = next.getContext('2d');
        if (!nextContext) throw new Error('The browser could not resize the photo.');
        nextContext.drawImage(canvas, 0, 0, next.width, next.height);
        canvas.width = next.width;
        canvas.height = next.height;
        context = canvas.getContext('2d');
        context.drawImage(next, 0, 0);
      }
    }
    if (blob.size > maximumPhotoBytes) throw new Error('Could not compress this photo below 1 MB. Choose a smaller image.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { type: blob.type, content: btoa(binary), width: canvas.width, height: canvas.height, bytes: blob.size };
  } finally {
    bitmap.close();
  }
}
