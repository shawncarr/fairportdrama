/**
 * UUID v7 - a 48-bit big-endian Unix timestamp in milliseconds followed by
 * random bits, laid out per RFC 9562.
 *
 * Used for audit rows because v7 sorts chronologically as a string. That makes
 * `ORDER BY id` equivalent to `ORDER BY created_at` without a second index,
 * and makes keyset pagination over the audit log stable even when several
 * rows share a millisecond.
 */
export function generateId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit timestamp, big-endian, bytes 0-5.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 9562 variant (0b10) in the high bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
