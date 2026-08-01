import type { ImageStore } from './types';

/**
 * Upload ceiling. Phone photos land around 3-5 MB; 10 MB leaves headroom
 * without inviting someone to push a video through the form.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Formats accepted, keyed by the content type actually served back.
 *
 * SVG is deliberately absent. An SVG can carry a <script> element, and the
 * local store serves its bytes from this site's own origin at /dev/images/...,
 * so an uploaded SVG would execute with the session cookie in scope. Nothing
 * on this site needs vector art, so the format is simply not allowed rather
 * than sanitised.
 */
const MAGIC: ReadonlyArray<{ contentType: string; test: (b: Uint8Array) => boolean }> = [
  { contentType: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    contentType: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    contentType: 'image/gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    // RIFF....WEBP - the four size bytes at offset 4 are skipped.
    contentType: 'image/webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/**
 * Identifies a format from the file's leading bytes.
 *
 * The browser-supplied Content-Type is not consulted at all: it is chosen by
 * the client, usually from the file extension, so renaming a file is enough to
 * change it. What gets stored has to be decided by what the bytes are.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  for (const { contentType, test } of MAGIC) {
    if (bytes.length >= 12 && test(bytes)) return contentType;
  }
  return null;
}

/**
 * What `FormData.get()` yields. Spelled out rather than using the DOM's
 * `FormDataEntryValue`, which workerd's generated types do not declare.
 */
export type FormEntry = File | string | null;

export type UploadOutcome =
  | { status: 'empty' }
  | { status: 'ok'; bytes: ArrayBuffer; contentType: string }
  | { status: 'error'; reason: string };

/**
 * Validates one file field from a submitted form.
 *
 * `empty` is a distinct outcome from `error`: an untouched file input still
 * submits a zero-byte entry, and that has to mean "leave the existing image
 * alone" rather than "clear it" or "reject the whole form".
 */
export async function readImageUpload(entry: FormEntry): Promise<UploadOutcome> {
  if (entry === null || typeof entry === 'string') return { status: 'empty' };

  const file = entry as File;
  if (file.size === 0) return { status: 'empty' };

  if (file.size > MAX_IMAGE_BYTES) {
    return {
      status: 'error',
      reason: `That image is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    };
  }

  const bytes = await file.arrayBuffer();
  const contentType = sniffImageType(new Uint8Array(bytes));
  if (!contentType) {
    return {
      status: 'error',
      reason: 'That file is not a JPEG, PNG, GIF, or WebP image.',
    };
  }

  return { status: 'ok', bytes, contentType };
}

/**
 * Validates and stores in one step, returning the new image id.
 *
 * Uploads pass through the Worker rather than using Direct Creator Upload. The
 * plan called for the latter, but it needs client-side JavaScript and a live
 * Cloudflare Images account, which would make photo upload untestable locally
 * and unusable without scripting. Going through `ImageStore.put()` keeps one
 * code path for both stores and keeps every form plain HTML. The cost is that
 * image bytes count against the Worker request body, which at a 10 MB ceiling
 * is well inside the 100 MB limit.
 */
export async function uploadImage(
  store: ImageStore,
  entry: FormEntry,
): Promise<{ imageId: string } | { error: string } | null> {
  const outcome = await readImageUpload(entry);
  if (outcome.status === 'empty') return null;
  if (outcome.status === 'error') return { error: outcome.reason };

  const imageId = await store.put(outcome.bytes, outcome.contentType);
  return { imageId };
}
