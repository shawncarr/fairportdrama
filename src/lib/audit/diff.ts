export interface AuditDiffEntry {
  before: unknown;
  after: unknown;
}

export type AuditDiff = Record<string, AuditDiffEntry>;

/**
 * Field-level diff for an update.
 *
 * Walks the keys of `patch`, not of `before` or `after`. That distinction
 * matters: iterating the model would surface every field that happens to
 * differ - including ones the caller never intended to touch, and ones that
 * differ only because of defaulting or serialization. Iterating the patch
 * records exactly what was asked to change.
 *
 * Keys whose value is unchanged are dropped, so an update that touched
 * nothing produces an empty diff rather than a row full of no-ops.
 *
 * This is a pure projection with no field-name awareness. Sensitive values
 * must be redacted by the caller before they reach here.
 */
export function buildDiff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  patch: Partial<T>,
): AuditDiff {
  const diff: AuditDiff = {};

  for (const key of Object.keys(patch)) {
    const prev = before[key];
    const next = after[key];
    if (!isEqual(prev, next)) {
      diff[key] = { before: prev, after: next };
    }
  }

  return diff;
}

export const isEmptyDiff = (diff: AuditDiff): boolean => Object.keys(diff).length === 0;

/**
 * Structural equality sufficient for JSON-shaped content values. Not a general
 * deep-equal: it does not handle cycles, Maps, Sets, or class instances,
 * none of which reach audit rows.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => isEqual(item, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        isEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }

  return false;
}
