import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, readImageUpload, sniffImageType, uploadImage } from './upload';
import type { ImageStore, ImageVariant } from './types';

const bytes = (...values: number[]) => new Uint8Array([...values, ...Array(12).fill(0)]);

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // size
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x00, 0x00, 0x00, 0x00,
]);

const file = (data: Uint8Array, name = 'x', type = 'image/jpeg') =>
  new File([data as BufferSource], name, { type });

describe('sniffImageType', () => {
  it('identifies each accepted format from its leading bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('rejects SVG, which can carry script and would run on our own origin', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });

  it('rejects HTML dressed up as an image', () => {
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><script>x</script>'))).toBeNull();
  });

  it('rejects a buffer too short to identify', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('does not mistake RIFF audio for WebP', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, 0x00, 0x00, 0x00, 0x00, // WAVE, not WEBP
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe('readImageUpload', () => {
  it('treats an untouched file input as empty, not as an error', async () => {
    // A form always submits the field; an unchosen file arrives zero-length.
    // Reading that as "clear the image" would silently delete photos.
    expect(await readImageUpload(file(new Uint8Array(0)))).toEqual({ status: 'empty' });
    expect(await readImageUpload(null)).toEqual({ status: 'empty' });
    expect(await readImageUpload('')).toEqual({ status: 'empty' });
  });

  it('accepts a real image and reports the sniffed type', async () => {
    const result = await readImageUpload(file(PNG, 'photo.png', 'image/png'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.contentType).toBe('image/png');
  });

  it('ignores the browser-declared type in favour of the bytes', async () => {
    // The client picks Content-Type, usually from the extension, so renaming a
    // file is enough to change it. Only the bytes decide what gets stored.
    const result = await readImageUpload(file(PNG, 'photo.jpg', 'image/jpeg'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.contentType).toBe('image/png');
  });

  it('rejects a non-image whatever it claims to be', async () => {
    const html = new TextEncoder().encode('<script>document.cookie</script>aaaaaaaa');
    const result = await readImageUpload(file(html, 'photo.jpg', 'image/jpeg'));
    expect(result.status).toBe('error');
  });

  it('rejects a file over the size ceiling', async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(JPEG.slice(0, 4));
    const result = await readImageUpload(file(huge));
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.reason).toContain('limit');
  });

  it('checks size before reading the body into memory', async () => {
    // An oversized upload must not be buffered just to find out it is
    // oversized. arrayBuffer() throwing proves the ceiling gated the read.
    const oversized = {
      size: MAX_IMAGE_BYTES + 1,
      arrayBuffer: () => Promise.reject(new Error('should not read')),
    } as unknown as File;
    expect((await readImageUpload(oversized)).status).toBe('error');
  });
});

describe('uploadImage', () => {
  const store = (): ImageStore & { stored: Array<{ contentType: string }> } => {
    const stored: Array<{ contentType: string }> = [];
    return {
      stored,
      name: 'Fake',
      deliveryUrl: (id: string | null | undefined, v: ImageVariant) => (id ? `/${id}/${v}` : null),
      put: async (_bytes: ArrayBuffer, contentType: string) => {
        stored.push({ contentType });
        return `img-${stored.length}`;
      },
      get: async () => null,
      delete: async () => {},
    };
  };

  it('returns null for an empty field so callers keep the existing image', async () => {
    const s = store();
    expect(await uploadImage(s, file(new Uint8Array(0)))).toBeNull();
    expect(s.stored).toHaveLength(0);
  });

  it('stores a valid image and returns its id', async () => {
    const s = store();
    const result = await uploadImage(s, file(JPEG));
    expect(result).toEqual({ imageId: 'img-1' });
    expect(s.stored).toEqual([{ contentType: 'image/jpeg' }]);
  });

  it('stores nothing when validation fails', async () => {
    const s = store();
    const result = await uploadImage(s, file(new TextEncoder().encode('not an image at all')));
    expect(result).toHaveProperty('error');
    expect(s.stored).toHaveLength(0);
  });
});
