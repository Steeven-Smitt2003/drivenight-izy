import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitWithin,
  isImageFile,
  prepareProfilePhoto,
} from '../src/lib/profile-photo.js';

test('isImageFile accepts every declared image type and common image extensions', () => {
  assert.equal(isImageFile({ type: 'image/heic', name: 'a.heic' }), true);
  assert.equal(isImageFile({ type: 'image/svg+xml', name: 'a.svg' }), true);
  assert.equal(isImageFile({ type: 'image/x-unknown', name: 'a' }), true);
  assert.equal(isImageFile({ type: '', name: 'IMG_0001.HEIF' }), true);
  assert.equal(isImageFile({ type: '', name: 'scan.TIFF' }), true);
  assert.equal(isImageFile({ type: 'application/pdf', name: 'a.pdf' }), false);
  assert.equal(isImageFile({ type: '', name: 'notes' }), false);
});

test('fitWithin keeps the ratio, never upscales, and never returns zero', () => {
  assert.deepEqual(fitWithin(4000, 2000, 512), { width: 512, height: 256 });
  assert.deepEqual(fitWithin(300, 200, 512), { width: 300, height: 200 });
  assert.deepEqual(fitWithin(5000, 1, 512), { width: 512, height: 1 });
});

test('prepareProfilePhoto converts a decodable image to a compact blob', async () => {
  const rendered = { size: 1200, type: 'image/jpeg' };
  const result = await prepareProfilePhoto(
    { type: 'image/png', name: 'a.png', size: 9_000_000 },
    {
      decode: async () => ({ width: 3000, height: 1500, close() {} }),
      render: async (image, size) => {
        assert.deepEqual(size, { width: 512, height: 256 });
        return rendered;
      },
    },
  );

  assert.equal(result.blob, rendered);
  assert.equal(result.converted, true);
});

test('prepareProfilePhoto keeps the original file when the browser cannot decode the image', async () => {
  const file = { type: 'image/heic', name: 'a.heic', size: 4_000_000 };
  const result = await prepareProfilePhoto(file, {
    decode: async () => { throw new Error('unsupported'); },
    render: async () => { throw new Error('unreachable'); },
  });

  assert.equal(result.blob, file);
  assert.equal(result.converted, false);
});

test('prepareProfilePhoto keeps the original image when rendering fails', async () => {
  const file = { type: 'image/avif', name: 'a.avif', size: 100 };
  const result = await prepareProfilePhoto(file, {
    decode: async () => ({ width: 10, height: 10, close() {} }),
    render: async () => { throw new Error('canvas'); },
  });

  assert.equal(result.blob, file);
  assert.equal(result.converted, false);
});

test('prepareProfilePhoto rejects a file that is not an image', async () => {
  await assert.rejects(
    prepareProfilePhoto(
      { type: 'application/pdf', name: 'a.pdf', size: 100 },
      { decode: async () => { throw new Error('no'); }, render: async () => ({}) },
    ),
    { message: 'PROFILE_PHOTO_INVALID' },
  );
});

test('prepareProfilePhoto rejects an undecodable original above the storage limit', async () => {
  await assert.rejects(
    prepareProfilePhoto(
      { type: 'image/heic', name: 'huge.heic', size: 30 * 1024 * 1024 },
      { decode: async () => { throw new Error('no'); }, render: async () => ({}) },
    ),
    { message: 'PROFILE_PHOTO_TOO_LARGE' },
  );
});
