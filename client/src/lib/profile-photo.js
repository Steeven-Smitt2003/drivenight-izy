export const MAX_PHOTO_SIDE = 512;
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'heic', 'heif',
  'bmp', 'tif', 'tiff', 'svg', 'ico', 'jxl', 'raw', 'dng', 'cr2', 'nef', 'arw',
]);

export function isImageFile(file) {
  const type = String(file?.type ?? '').toLowerCase();
  if (type.startsWith('image/')) return true;
  const name = String(file?.name ?? '').toLowerCase();
  if (!name.includes('.')) return false;
  return IMAGE_EXTENSIONS.has(name.split('.').pop());
}

export function fitWithin(width, height, max = MAX_PHOTO_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeInBrowser(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Repli sur un élément <img>, plus tolérant (SVG, formats gérés par la vue web).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('PROFILE_PHOTO_UNDECODABLE'));
      image.src = url;
    });
    const width = element.naturalWidth || MAX_PHOTO_SIDE;
    const height = element.naturalHeight || MAX_PHOTO_SIDE;
    return { source: element, width, height, close() {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderInBrowser(image, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS_UNAVAILABLE');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image.source, 0, 0, size.width, size.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('CANVAS_ENCODING_FAILED');
  return blob;
}

export async function prepareProfilePhoto(file, deps = {
  decode: decodeInBrowser,
  render: renderInBrowser,
}) {
  let image = null;
  try {
    image = await deps.decode(file);
  } catch {
    image = null;
  }

  if (image) {
    try {
      const blob = await deps.render(image, fitWithin(image.width, image.height));
      return { blob, converted: true };
    } catch {
      // On garde le fichier d'origine plutôt que de refuser une image valide.
    } finally {
      image.close?.();
    }
  }

  if (!isImageFile(file)) throw new Error('PROFILE_PHOTO_INVALID');
  if (file.size > MAX_ORIGINAL_BYTES) throw new Error('PROFILE_PHOTO_TOO_LARGE');
  return { blob: file, converted: false };
}
